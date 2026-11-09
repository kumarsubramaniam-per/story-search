import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chunk } from "./chunk.js";

const c = vi.hoisted(() => ({ query: vi.fn(), delete: vi.fn(), upsert: vi.fn() }));
vi.mock("@zilliz/milvus2-sdk-node", () => ({
  MilvusClient: class {
    query = c.query;
    delete = c.delete;
    upsert = c.upsert;
  },
  DataType: {},
}));
vi.mock("./embed.js", () => ({ EMBEDDING_DIMS: 1536 }));

const { withTimeout, getStoredHashes, listChunkIdsBySource, deleteChunks, upsertChunks, COLLECTION } = await import("./milvus.js");

beforeEach(() => {
  for (const fn of Object.values(c)) fn.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("withTimeout", () => {
  it("passes through the result of a promise that settles in time", async () => {
    await expect(withTimeout(Promise.resolve(7), "x")).resolves.toBe(7);
  });

  it("passes through the rejection of a promise that fails in time", async () => {
    await expect(withTimeout(Promise.reject(new Error("bad")), "x")).rejects.toThrow("bad");
  });

  it("rejects with the operation's label when it takes too long", async () => {
    vi.useFakeTimers();
    const slow = new Promise<never>(() => {});
    const result = withTimeout(slow, "search", 5000).catch((e) => e);
    await vi.advanceTimersByTimeAsync(5001);
    expect((await result).message).toBe("Milvus search timed out after 5s");
  });
});

describe("getStoredHashes", () => {
  it("looks ids up by primary key, with a quoted, escaped list", async () => {
    c.query.mockResolvedValue({ data: [{ chunk_id: "story-a", content_hash: "h1" }] });
    const map = await getStoredHashes(["story-a", 'story-"odd"']);
    expect(c.query.mock.calls[0][0]).toMatchObject({
      collection_name: COLLECTION,
      filter: 'chunk_id in ["story-a","story-\\"odd\\""]',
      limit: 2,
    });
    expect(map).toEqual(new Map([["story-a", "h1"]]));
  });
});

describe("listChunkIdsBySource", () => {
  it("reads page by page until a short page, filtering on the source file", async () => {
    const page = (n: number, from = 0) => ({ data: Array.from({ length: n }, (_, i) => ({ chunk_id: `s-${from + i}` })) });
    c.query.mockResolvedValueOnce(page(1000)).mockResolvedValueOnce(page(3, 1000));
    const ids = await listChunkIdsBySource('dir/a "b".md');
    expect(ids).toHaveLength(1003);
    expect(c.query.mock.calls.map((x) => x[0].offset)).toEqual([0, 1000]);
    expect(c.query.mock.calls[0][0].filter).toBe('source_file == "dir/a \\"b\\".md"');
  });

  it("returns an empty list for a file with no rows", async () => {
    c.query.mockResolvedValue({ data: [] });
    expect(await listChunkIdsBySource("a.md")).toEqual([]);
  });

  it("fails loudly rather than silently truncating when there are too many rows", async () => {
    c.query.mockImplementation(async () => ({ data: Array.from({ length: 1000 }, (_, i) => ({ chunk_id: `s-${i}` })) }));
    await expect(listChunkIdsBySource("a.md")).rejects.toThrow(/queryIterator/);
  });
});

describe("writes", () => {
  it("deleteChunks deletes by primary key", async () => {
    c.delete.mockResolvedValue({});
    await deleteChunks(["story-a", "story-b"]);
    expect(c.delete).toHaveBeenCalledWith({ collection_name: COLLECTION, filter: 'chunk_id in ["story-a","story-b"]' });
  });

  it("upsertChunks pairs each chunk with its own embedding", async () => {
    c.upsert.mockResolvedValue({});
    const chunk = (id: string): Chunk => ({ chunk_id: id, story_id: id, title: id, text: id, source_file: "a.md", content_hash: "h" });
    await upsertChunks([chunk("a"), chunk("b")], [[1], [2]]);
    const data = c.upsert.mock.calls[0][0].data;
    expect(data.map((d: { chunk_id: string; embedding: number[] }) => [d.chunk_id, d.embedding])).toEqual([["a", [1]], ["b", [2]]]);
  });
});
