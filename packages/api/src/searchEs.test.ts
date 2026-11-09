import { beforeEach, describe, expect, it, vi } from "vitest";

const esSearch = vi.hoisted(() => vi.fn());
const ctor = vi.hoisted(() => vi.fn());
vi.mock("@elastic/elasticsearch", () => ({
  Client: class {
    constructor(opts: unknown) {
      ctor(opts);
    }
    search = esSearch;
  },
}));

const { getEsUrl, getAnalyzer, searchKeyword, ES_INDEX } = await import("./searchEs.js");

beforeEach(() => {
  esSearch.mockReset();
  delete process.env.ELASTICSEARCH_URL;
  delete process.env.ELASTICSEARCH_ANALYZER;
});

describe("configuration", () => {
  it("getEsUrl is null when unset or blank, otherwise the trimmed URL", () => {
    expect(getEsUrl()).toBeNull();
    process.env.ELASTICSEARCH_URL = "  ";
    expect(getEsUrl()).toBeNull();
    process.env.ELASTICSEARCH_URL = " http://localhost:9200 ";
    expect(getEsUrl()).toBe("http://localhost:9200");
  });

  it("getAnalyzer defaults to english and honours the setting", () => {
    expect(getAnalyzer()).toBe("english");
    process.env.ELASTICSEARCH_ANALYZER = " standard ";
    expect(getAnalyzer()).toBe("standard");
  });
});

describe("searchKeyword", () => {
  it("refuses to run when Elasticsearch is not configured", async () => {
    await expect(searchKeyword("sample", 3)).rejects.toThrow(/ELASTICSEARCH_URL/);
    expect(esSearch).not.toHaveBeenCalled();
  });

  it("queries title (boosted) and text, with no client retries, and maps hits", async () => {
    process.env.ELASTICSEARCH_URL = "http://localhost:9200";
    esSearch.mockResolvedValue({
      hits: {
        hits: [
          { _score: 3.5, _source: { chunk_id: "c-a", story_id: "a", title: "T a", text: "y".repeat(400) } },
          { _score: null, _source: { chunk_id: "c-b", story_id: "b", title: "T b", text: "short" } },
        ],
      },
    });
    const hits = await searchKeyword("sample words", 2);
    const args = esSearch.mock.calls[0][0];
    expect(args).toMatchObject({ index: ES_INDEX, size: 2 });
    expect(args.query.multi_match).toMatchObject({ query: "sample words", fields: ["title^3", "text"] });
    expect(ctor).toHaveBeenCalledWith(expect.objectContaining({ node: "http://localhost:9200", maxRetries: 0 }));
    expect(hits[0]).toMatchObject({ chunk_id: "c-a", story_id: "a", score: 3.5 });
    expect(hits[0].snippet).toHaveLength(300);
    expect(hits[0].text).toHaveLength(400);
    expect(hits[1].score).toBe(0); // a missing score becomes 0
  });

  it("returns an empty list when nothing matches", async () => {
    process.env.ELASTICSEARCH_URL = "http://localhost:9200";
    esSearch.mockResolvedValue({ hits: { hits: [] } });
    expect(await searchKeyword("nothing", 3)).toEqual([]);
  });
});
