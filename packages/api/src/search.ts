import { searchByVector, searchStories, type SearchHit } from "./searchMilvus.js";
import { searchKeyword, getEsUrl } from "./searchEs.js";
import { embedTexts } from "./embed.js";
import { fuse } from "./fusion.js";

// How stories are found: by meaning (vector), by words (keyword, BM25), or both fused with RRF (hybrid).
export type SearchMode = "vector" | "keyword" | "hybrid";
export const SEARCH_MODES: SearchMode[] = ["vector", "keyword", "hybrid"];

/** A problem with the request itself (not a crash); the status code goes back to the caller. */
export class RequestError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}

/** Which modes this server can serve right now, given what is configured. Keyword and hybrid need Elasticsearch. */
export function availableModes(): Record<SearchMode, boolean> {
  const es = getEsUrl() !== null;
  return { vector: true, keyword: es, hybrid: es };
}

/** SEARCH_MODE from .env; "vector" when unset. */
export function defaultMode(): SearchMode {
  const raw = process.env.SEARCH_MODE?.trim();
  if (!raw) return "vector";
  if (!SEARCH_MODES.includes(raw as SearchMode)) throw new Error(`SEARCH_MODE must be one of: ${SEARCH_MODES.join(", ")}`);
  return raw as SearchMode;
}

/**
 * How many candidates each search hands to the fusion step: at least 20, or 3x k. More than k, so a story ranked
 * 4th by both methods can still win; not so many that weak agreement outweighs one method's strong match.
 */
export function poolSize(k: number): number {
  return Math.max(20, 3 * k);
}

export type SearchOptions = { pool?: number }; // pool overrides poolSize(k); the eval uses it to experiment

/**
 * Finds the top-k stories for a query in the given mode. A precomputed query vector skips the embedding call
 * (vector and hybrid modes). Hybrid runs both searches at the same time and merges their rankings with RRF.
 */
export async function search(
  query: string,
  k: number,
  mode: SearchMode,
  queryVector?: number[],
  options: SearchOptions = {},
): Promise<SearchHit[]> {
  if ((mode === "keyword" || mode === "hybrid") && !getEsUrl()) {
    throw new RequestError("Keyword and hybrid search need ELASTICSEARCH_URL in .env, with Elasticsearch running (npm run dev:up).");
  }
  if (mode === "keyword") return searchKeyword(query, k);

  if (mode === "hybrid") {
    const pool = options.pool ?? poolSize(k);
    const vector = queryVector ?? (await embedTexts([query]))[0];
    // MIN_SCORE (inside searchByVector) trims weak vector hits before fusing, so an unrelated query is not
    // lifted by one lucky keyword match.
    const [fromVector, fromKeyword] = await Promise.all([searchByVector(vector, pool), searchKeyword(query, pool)]);
    return fuse(
      [
        { name: "vector", hits: fromVector },
        { name: "keyword", hits: fromKeyword },
      ],
      k,
    );
  }

  return queryVector ? searchByVector(queryVector, k) : searchStories(query, k);
}
