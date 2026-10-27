import { milvus, COLLECTION, withTimeout } from "./milvus.js";
import { embedTexts } from "./embed.js";

export type SearchHit = {
  chunk_id: string;
  story_id: string;
  title: string;
  snippet: string;
  text: string; // full story text; used to build the RAG prompt, left out of /search responses
  score: number;
};

const SNIPPET_CHARS = 300;

let loading: Promise<unknown> | undefined;

/** Vector search: the k stories whose embeddings are closest to `vector`. */
export async function searchByVector(vector: number[], k: number): Promise<SearchHit[]> {
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
  return res.results.map((h: any) => ({
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
