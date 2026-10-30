import { searchByVector, searchStories, type SearchHit } from "./searchMilvus.js";
import { searchKeyword, getEsUrl } from "./searchEs.js";

// How stories are found: by meaning (vector), by words (keyword, BM25), or both fused with RRF (hybrid, milestone 7).
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

/** Which modes this server can serve right now, given what is configured. */
export function availableModes(): Record<SearchMode, boolean> {
  return { vector: true, keyword: getEsUrl() !== null, hybrid: false }; // hybrid arrives in milestone 7
}

/** SEARCH_MODE from .env; "vector" when unset. */
export function defaultMode(): SearchMode {
  const raw = process.env.SEARCH_MODE?.trim();
  if (!raw) return "vector";
  if (!SEARCH_MODES.includes(raw as SearchMode)) throw new Error(`SEARCH_MODE must be one of: ${SEARCH_MODES.join(", ")}`);
  return raw as SearchMode;
}

/** Finds the top-k stories for a query in the given mode. A precomputed query vector skips the embedding call. */
export async function search(query: string, k: number, mode: SearchMode, queryVector?: number[]): Promise<SearchHit[]> {
  if (mode === "hybrid") {
    throw new RequestError("Hybrid search arrives in milestone 7. Use mode=vector or mode=keyword.", 501);
  }
  if (mode === "keyword") {
    if (!getEsUrl()) {
      throw new RequestError("Keyword search needs ELASTICSEARCH_URL in .env, with Elasticsearch running (npm run dev:up).");
    }
    return searchKeyword(query, k);
  }
  return queryVector ? searchByVector(queryVector, k) : searchStories(query, k);
}
