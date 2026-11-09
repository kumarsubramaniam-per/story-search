import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchHit } from "./searchMilvus.js";

const m = vi.hoisted(() => ({
  searchByVector: vi.fn(),
  searchStories: vi.fn(),
  searchKeyword: vi.fn(),
  embedTexts: vi.fn(),
}));
vi.mock("./searchMilvus.js", () => ({ searchByVector: m.searchByVector, searchStories: m.searchStories }));
vi.mock("./searchEs.js", () => ({
  searchKeyword: m.searchKeyword,
  getEsUrl: () => process.env.ELASTICSEARCH_URL?.trim() || null,
}));
vi.mock("./embed.js", () => ({ embedTexts: m.embedTexts }));

const { search, availableModes, defaultMode, poolSize, RequestError, SEARCH_MODES } = await import("./search.js");

const hit = (id: string): SearchHit => ({ chunk_id: `c-${id}`, story_id: id, title: id, snippet: "", text: "", score: 1 });

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  delete process.env.ELASTICSEARCH_URL;
  delete process.env.SEARCH_MODE;
});

describe("availableModes", () => {
  it("offers only vector without Elasticsearch, and all three with it", () => {
    expect(availableModes()).toEqual({ vector: true, keyword: false, hybrid: false });
    process.env.ELASTICSEARCH_URL = "http://localhost:9200";
    expect(availableModes()).toEqual({ vector: true, keyword: true, hybrid: true });
  });
});

describe("defaultMode", () => {
  it("is vector when SEARCH_MODE is unset or blank", () => {
    expect(defaultMode()).toBe("vector");
    process.env.SEARCH_MODE = "  ";
    expect(defaultMode()).toBe("vector");
  });

  it("accepts each valid mode, trimmed", () => {
    for (const mode of SEARCH_MODES) {
      process.env.SEARCH_MODE = ` ${mode} `;
      expect(defaultMode()).toBe(mode);
    }
  });

  it("rejects anything else with a message that lists the choices", () => {
    process.env.SEARCH_MODE = "fuzzy";
    expect(() => defaultMode()).toThrow(/vector, keyword, hybrid/);
  });
});

describe("poolSize", () => {
  it("is at least 20 and otherwise 3x k", () => {
    expect(poolSize(1)).toBe(20);
    expect(poolSize(6)).toBe(20);
    expect(poolSize(7)).toBe(21);
    expect(poolSize(10)).toBe(30);
  });
});

describe("search", () => {
  it("vector mode embeds the query when no vector is given", async () => {
    m.searchStories.mockResolvedValue([hit("a")]);
    expect(await search("sample", 3, "vector")).toEqual([hit("a")]);
    expect(m.searchStories).toHaveBeenCalledWith("sample", 3);
    expect(m.embedTexts).not.toHaveBeenCalled(); // embedding happens inside searchStories
  });

  it("vector mode with a precomputed vector skips embedding", async () => {
    m.searchByVector.mockResolvedValue([hit("a")]);
    await search("sample", 3, "vector", [0.1, 0.2]);
    expect(m.searchByVector).toHaveBeenCalledWith([0.1, 0.2], 3);
    expect(m.searchStories).not.toHaveBeenCalled();
  });

  it("keyword and hybrid fail with a 400 RequestError when Elasticsearch is not configured", async () => {
    for (const mode of ["keyword", "hybrid"] as const) {
      const err = await search("sample", 3, mode).catch((e) => e);
      expect(err).toBeInstanceOf(RequestError);
      expect(err.statusCode).toBe(400);
      expect(err.message).toMatch(/ELASTICSEARCH_URL/);
    }
    expect(m.embedTexts).not.toHaveBeenCalled();
    expect(m.searchKeyword).not.toHaveBeenCalled();
  });

  it("keyword mode searches Elasticsearch for k hits and makes no embedding call", async () => {
    process.env.ELASTICSEARCH_URL = "http://localhost:9200";
    m.searchKeyword.mockResolvedValue([hit("k1")]);
    expect(await search("sample", 3, "keyword")).toEqual([hit("k1")]);
    expect(m.searchKeyword).toHaveBeenCalledWith("sample", 3);
    expect(m.embedTexts).not.toHaveBeenCalled();
  });

  describe("hybrid", () => {
    beforeEach(() => {
      process.env.ELASTICSEARCH_URL = "http://localhost:9200";
    });

    it("embeds once, asks both searches for a pool of candidates, and fuses with ranks", async () => {
      m.embedTexts.mockResolvedValue([[0.5]]);
      m.searchByVector.mockResolvedValue([hit("a"), hit("b")]);
      m.searchKeyword.mockResolvedValue([hit("b"), hit("c")]);
      const out = await search("sample", 3, "hybrid");
      expect(m.embedTexts).toHaveBeenCalledOnce();
      expect(m.searchByVector).toHaveBeenCalledWith([0.5], 20);
      expect(m.searchKeyword).toHaveBeenCalledWith("sample", 20);
      expect(out.map((h) => h.story_id)).toEqual(["b", "a", "c"]);
      expect(out[0].ranks).toEqual({ vector: 2, keyword: 1 });
    });

    it("honours a precomputed vector and a pool override, and trims to k", async () => {
      m.searchByVector.mockResolvedValue([hit("a"), hit("b"), hit("c")]);
      m.searchKeyword.mockResolvedValue([]);
      const out = await search("sample", 2, "hybrid", [0.9], { pool: 7 });
      expect(m.embedTexts).not.toHaveBeenCalled();
      expect(m.searchByVector).toHaveBeenCalledWith([0.9], 7);
      expect(m.searchKeyword).toHaveBeenCalledWith("sample", 7);
      expect(out).toHaveLength(2);
    });

    it("fails the whole search if either side fails", async () => {
      m.embedTexts.mockResolvedValue([[0.5]]);
      m.searchByVector.mockResolvedValue([]);
      m.searchKeyword.mockRejectedValue(new Error("es down"));
      await expect(search("sample", 3, "hybrid")).rejects.toThrow("es down");
    });
  });
});
