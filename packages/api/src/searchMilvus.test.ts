import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ loadCollection: vi.fn(), search: vi.fn(), embedTexts: vi.fn() }));
vi.mock("./milvus.js", () => ({
  COLLECTION: "stories",
  milvus: { loadCollection: m.loadCollection, search: m.search },
  withTimeout: <T>(p: Promise<T>) => p,
}));
vi.mock("./embed.js", () => ({ embedTexts: m.embedTexts }));

const { getMinScore, searchByVector, searchStories } = await import("./searchMilvus.js");

const row = (id: string, score: number, text = `Body ${id}`) => ({ chunk_id: `c-${id}`, story_id: id, title: `T ${id}`, text, score });

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.loadCollection.mockResolvedValue({});
  delete process.env.MIN_SCORE;
});

describe("getMinScore", () => {
  it("is null when unset or blank", () => {
    expect(getMinScore()).toBeNull();
    process.env.MIN_SCORE = "   ";
    expect(getMinScore()).toBeNull();
  });

  it("parses a number in range, including the bounds and zero", () => {
    for (const [raw, value] of [["0.2", 0.2], [" 0.35 ", 0.35], ["0", 0], ["-1", -1], ["1", 1]] as const) {
      process.env.MIN_SCORE = raw;
      expect(getMinScore()).toBe(value);
    }
  });

  it("rejects values that are not numbers or fall outside -1..1", () => {
    for (const raw of ["abc", "1.5", "-1.01", "NaN", "Infinity"]) {
      process.env.MIN_SCORE = raw;
      expect(() => getMinScore(), raw).toThrow(/MIN_SCORE/);
    }
  });
});

describe("searchByVector", () => {
  it("queries the stories collection with one vector and k, asking only for needed fields", async () => {
    m.search.mockResolvedValue({ results: [] });
    await searchByVector([0.1, 0.2], 4);
    const args = m.search.mock.calls[0][0];
    expect(args).toMatchObject({ collection_name: "stories", data: [[0.1, 0.2]], limit: 4 });
    expect(args.output_fields).not.toContain("vector");
  });

  it("maps rows to hits, with a snippet cut to 300 characters and the full text kept", async () => {
    m.search.mockResolvedValue({ results: [row("a", 0.8, "x".repeat(500))] });
    const [h] = await searchByVector([0], 1);
    expect(h).toMatchObject({ chunk_id: "c-a", story_id: "a", title: "T a", score: 0.8 });
    expect(h.snippet).toHaveLength(300);
    expect(h.text).toHaveLength(500);
  });

  it("drops hits below MIN_SCORE but keeps one exactly at it", async () => {
    process.env.MIN_SCORE = "0.2";
    m.search.mockResolvedValue({ results: [row("hi", 0.5), row("edge", 0.2), row("lo", 0.19)] });
    const hits = await searchByVector([0], 3);
    expect(hits.map((h) => h.story_id)).toEqual(["hi", "edge"]);
  });

  it("an explicit null threshold keeps everything, even when MIN_SCORE is set", async () => {
    process.env.MIN_SCORE = "0.9";
    m.search.mockResolvedValue({ results: [row("a", 0.01)] });
    expect(await searchByVector([0], 3, null)).toHaveLength(1);
  });

  it("an explicit threshold overrides MIN_SCORE", async () => {
    process.env.MIN_SCORE = "0.9";
    m.search.mockResolvedValue({ results: [row("a", 0.3)] });
    expect(await searchByVector([0], 3, 0.2)).toHaveLength(1);
  });

  it("returns an empty list when every hit is below the threshold", async () => {
    m.search.mockResolvedValue({ results: [row("a", 0.05)] });
    expect(await searchByVector([0], 3, 0.2)).toEqual([]);
  });
});

describe("searchStories", () => {
  it("embeds the query text then searches with that vector", async () => {
    m.embedTexts.mockResolvedValue([[0.7]]);
    m.search.mockResolvedValue({ results: [row("a", 0.6)] });
    const hits = await searchStories("sample", 3);
    expect(m.embedTexts).toHaveBeenCalledWith(["sample"]);
    expect(m.search.mock.calls[0][0].data).toEqual([[0.7]]);
    expect(hits).toHaveLength(1);
  });
});
