import { milvus, COLLECTION, withTimeout } from "./milvus.js";
import { embedTexts } from "./embed.js";

export type SearchHit = {
  chunk_id: string;
  story_id: string;
  title: string;
  snippet: string;
  text: string; // full story text; used to build the RAG prompt, left out of /search responses
  score: number; // meaning depends on the mode: cosine similarity, BM25, or the RRF sum
  ranks?: { vector?: number; keyword?: number }; // hybrid only: the story's rank in each list it appeared in
};

const SNIPPET_CHARS = 300;

let loading: Promise<unknown> | undefined;

/**
 * MIN_SCORE from .env: hits scoring below it are dropped. Unset means no filtering (null).
 * Cosine scores depend on the embedding model and the content, so the right value is found by looking at the
 * score gap `npm run eval` reports, not assumed.
 */
export function getMinScore(): number | null {
  const raw = process.env.MIN_SCORE?.trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < -1 || value > 1) throw new Error("MIN_SCORE must be a number between -1 and 1");
  return value;
}

/**
 * Vector search: the up-to-k stories whose embeddings are closest to `vector`, best first. Hits below `minScore`
 * (default: MIN_SCORE) are dropped, so an off-topic query can return nothing. Pass null to keep every hit.
 */
export async function searchByVector(
  vector: number[],
  k: number,
  minScore: number | null = getMinScore(),
): Promise<SearchHit[]> {
  // A collection must be loaded into memory before it can be searched; do it once per process.
  loading ??= milvus.loadCollection({ collection_name: COLLECTION });
  try {
    await withTimeout(loading, "load");
  } catch (err) {
    loading = undefined; // let the next request try again
    throw err;
  }

  const res = await withTimeout(
    milvus.search({
      collection_name: COLLECTION,
      data: [vector], // one query vector; Milvus uses the COSINE metric the index was built with
      limit: k,
      // Ask only for what the page needs; the 1536-float embedding stays in Milvus.
      output_fields: ["chunk_id", "story_id", "title", "text"],
    }),
    "search",
  );

  // For COSINE a higher score means more similar. Hits come back best first.
  return res.results
    .filter((h: any) => minScore === null || h.score >= minScore)
    .map((h: any) => ({
      chunk_id: h.chunk_id,
      story_id: h.story_id,
      title: h.title,
      snippet: String(h.text).slice(0, SNIPPET_CHARS),
      text: String(h.text),
      score: h.score,
    }));
}

/** Semantic search: embed the query text (one paid OpenAI call), then search. */
export async function searchStories(query: string, k: number): Promise<SearchHit[]> {
  const [vector] = await embedTexts([query]);
  return searchByVector(vector, k);
}
