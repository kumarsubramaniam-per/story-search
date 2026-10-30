import type { SearchHit } from "./searchMilvus.js";

// The constant in 1 / (RRF_K + rank). 60 is the value from the original RRF paper and what most systems use.
// A large constant keeps the gap between neighbouring ranks small, so agreement between lists counts for more
// than one list's top spot.
export const RRF_K = 60;

export type RankedList = { name: "vector" | "keyword"; hits: SearchHit[] };

/**
 * Reciprocal rank fusion: merges ranked lists into one using only each story's rank in each list, never its score
 * (cosine and BM25 scores are on different scales). A story earns 1 / (RRF_K + rank) from every list it appears in;
 * the earnings are added up and the stories sorted. Each result's `score` is that sum and `ranks` says where the
 * story stood in each list. Plain arithmetic: no model is involved.
 */
export function fuse(lists: RankedList[], limit: number): SearchHit[] {
  const merged = new Map<string, SearchHit>();
  for (const { name, hits } of lists) {
    hits.forEach((hit, index) => {
      const rank = index + 1;
      const entry = merged.get(hit.chunk_id) ?? { ...hit, score: 0, ranks: {} };
      entry.score += 1 / (RRF_K + rank);
      entry.ranks = { ...entry.ranks, [name]: rank };
      merged.set(hit.chunk_id, entry);
    });
  }
  // Array.prototype.sort is stable, so equal scores keep the order the lists introduced them (vector first).
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
