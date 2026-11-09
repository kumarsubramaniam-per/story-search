import { describe, expect, it } from "vitest";
import { fuse, RRF_K } from "./fusion.js";
import type { SearchHit } from "./searchMilvus.js";

const hit = (id: string): SearchHit => ({ chunk_id: `c-${id}`, story_id: id, title: `Title ${id}`, snippet: "", text: "", score: 0 });
const list = (name: "vector" | "keyword", ...ids: string[]) => ({ name, hits: ids.map(hit) });

describe("fuse (reciprocal rank fusion)", () => {
  it("scores a single list by 1 / (RRF_K + rank) and keeps its order", () => {
    const out = fuse([list("vector", "a", "b")], 10);
    expect(out.map((h) => h.story_id)).toEqual(["a", "b"]);
    expect(out[0].score).toBeCloseTo(1 / (RRF_K + 1));
    expect(out[1].score).toBeCloseTo(1 / (RRF_K + 2));
  });

  it("adds up the earnings of a story that appears in both lists and records both ranks", () => {
    const out = fuse([list("vector", "a", "b"), list("keyword", "b", "a")], 10);
    const b = out.find((h) => h.story_id === "b")!;
    expect(b.score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1));
    expect(b.ranks).toEqual({ vector: 2, keyword: 1 });
  });

  it("lets a story both methods like beat one that only a single method ranked first", () => {
    const out = fuse([list("vector", "solo", "both"), list("keyword", "other", "both")], 10);
    expect(out[0].story_id).toBe("both");
  });

  it("ignores the incoming scores: only ranks count", () => {
    const high = { ...hit("a"), score: 999 };
    const low = { ...hit("b"), score: 0.01 };
    const out = fuse([{ name: "vector", hits: [low, high] }], 10);
    expect(out.map((h) => h.story_id)).toEqual(["b", "a"]);
  });

  it("breaks ties in favour of the list given first (vector)", () => {
    const out = fuse([list("vector", "v"), list("keyword", "k")], 10);
    expect(out.map((h) => h.story_id)).toEqual(["v", "k"]);
  });

  it("applies the limit after sorting", () => {
    const out = fuse([list("vector", "a", "b", "c", "d")], 2);
    expect(out.map((h) => h.story_id)).toEqual(["a", "b"]);
  });

  it("returns nothing for empty lists, and does not mutate its inputs", () => {
    expect(fuse([list("vector"), list("keyword")], 3)).toEqual([]);
    expect(fuse([], 3)).toEqual([]);
    const input = list("vector", "a");
    fuse([input, list("keyword", "a")], 3);
    expect(input.hits[0].ranks).toBeUndefined();
    expect(input.hits[0].score).toBe(0);
  });

  it("gives a hit found by one list only a single rank entry", () => {
    const [only] = fuse([list("keyword", "a")], 3);
    expect(only.ranks).toEqual({ keyword: 1 });
  });
});
