import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chunkStories, embedInput } from "./chunk.js";

// ingest.ts is a script: it runs when imported. Each test sets argv and env, then imports it fresh.
const m = vi.hoisted(() => ({
  listSourceFiles: vi.fn(),
  loadLines: vi.fn(),
  embedTexts: vi.fn(),
  totalEmbeddingTokens: vi.fn(),
  logEvent: vi.fn(),
  ensureCollection: vi.fn(),
  getStoredHashes: vi.fn(),
  upsertChunks: vi.fn(),
  listChunkIdsBySource: vi.fn(),
  deleteChunks: vi.fn(),
  closeConnection: vi.fn(),
  pingEs: vi.fn(),
  ensureEsIndex: vi.fn(),
  indexChunks: vi.fn(),
  deleteStaleEs: vi.fn(),
  closeEs: vi.fn(),
}));
vi.mock("./source.js", () => ({ listSourceFiles: m.listSourceFiles, loadLines: m.loadLines }));
vi.mock("./embed.js", () => ({ embedTexts: m.embedTexts, totalEmbeddingTokens: m.totalEmbeddingTokens }));
vi.mock("./activity.js", () => ({ logEvent: m.logEvent }));
vi.mock("./milvus.js", () => ({
  ensureCollection: m.ensureCollection,
  getStoredHashes: m.getStoredHashes,
  upsertChunks: m.upsertChunks,
  listChunkIdsBySource: m.listChunkIdsBySource,
  deleteChunks: m.deleteChunks,
  milvus: { closeConnection: m.closeConnection },
}));
vi.mock("./searchEs.js", () => ({
  getEsUrl: () => process.env.ELASTICSEARCH_URL?.trim() || null,
  pingEs: m.pingEs,
  ensureEsIndex: m.ensureEsIndex,
  indexChunks: m.indexChunks,
  deleteStaleEs: m.deleteStaleEs,
  closeEs: m.closeEs,
}));

const originalArgv = process.argv;
const files: Record<string, string[]> = {};

/** Runs ingest.ts with the given command-line flags. Rejects if the script throws. */
async function runIngest(...flags: string[]) {
  process.argv = ["node", "ingest.ts", ...flags];
  vi.resetModules();
  await import("./ingest.js");
}

const story = (title: string, body: string) => [`# ${title}`, body];
const chunkOf = (title: string, body: string) => chunkStories(story(title, body), "x.md")[0];
const lastIngestLog = () => m.logEvent.mock.calls.filter((c) => c[0] === "ingest").at(-1)![1];

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  for (const k of Object.keys(files)) delete files[k];
  process.env.STORIES_DIR = "/sample/stories";
  delete process.env.STORY_HEADER_PATTERN;
  delete process.env.STORY_BODY_START_PATTERN;
  m.listSourceFiles.mockImplementation(() => Object.keys(files));
  m.loadLines.mockImplementation(async (_dir: string, file: string) => files[file]);
  m.totalEmbeddingTokens.mockReturnValue(42);
  m.getStoredHashes.mockResolvedValue(new Map());
  m.embedTexts.mockImplementation(async (texts: string[]) => texts.map(() => [0.1]));
  m.listChunkIdsBySource.mockResolvedValue([]);
  m.deleteStaleEs.mockResolvedValue(0);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

describe("configuration errors", () => {
  it("needs STORIES_DIR", async () => {
    delete process.env.STORIES_DIR;
    await expect(runIngest()).rejects.toThrow(/STORIES_DIR/);
  });

  it("needs at least one source file", async () => {
    await expect(runIngest()).rejects.toThrow(/No .pdf, .txt or .md files/);
    expect(m.embedTexts).not.toHaveBeenCalled();
  });

  it("rejects a bad --batch-size", async () => {
    files["a.md"] = story("One", "text");
    for (const bad of ["0", "-2", "1.5", "abc"]) {
      await expect(runIngest("--batch-size", bad), bad).rejects.toThrow(/batch-size/);
    }
    await expect(runIngest("--batch-size")).rejects.toThrow(/batch-size/);
  });

  it("rejects an invalid or title-less STORY_HEADER_PATTERN before doing any work", async () => {
    files["a.md"] = story("One", "text");
    process.env.STORY_HEADER_PATTERN = "([unclosed";
    await expect(runIngest()).rejects.toThrow(/STORY_HEADER_PATTERN is not a valid regular expression/);
    process.env.STORY_HEADER_PATTERN = "^## (.+)$";
    await expect(runIngest()).rejects.toThrow(/\(\?<title>/);
    expect(m.ensureCollection).not.toHaveBeenCalled();
  });
});

describe("--dry-run", () => {
  it("parses only: no OpenAI, Milvus or Elasticsearch calls, and says so in the log", async () => {
    process.env.ELASTICSEARCH_URL = "http://localhost:9200";
    files["a.md"] = story("One", "text");
    await runIngest("--dry-run");
    for (const fn of [m.ensureCollection, m.getStoredHashes, m.embedTexts, m.upsertChunks, m.pingEs, m.ensureEsIndex, m.indexChunks]) {
      expect(fn).not.toHaveBeenCalled();
    }
    expect(lastIngestLog()).toMatchObject({ dry_run: true, files: 1, stories: 1, embedded: 0 });
  });
});

describe("embedding only what is new or changed (cost guardrail)", () => {
  it("embeds and upserts new stories", async () => {
    files["a.md"] = story("One", "first body");
    await runIngest();
    expect(m.ensureCollection).toHaveBeenCalledWith(false);
    expect(m.embedTexts).toHaveBeenCalledWith([embedInput({ title: "One", text: "first body" })]);
    expect(m.upsertChunks).toHaveBeenCalledOnce();
    expect(lastIngestLog()).toMatchObject({ stories: 1, embedded: 1, skipped: 0, embedding_tokens: 42 });
  });

  it("skips stories whose stored hash matches, and embeds only the changed one", async () => {
    files["a.md"] = [...story("One", "same"), "", ...story("Two", "edited")].filter(Boolean);
    process.env.STORY_HEADER_PATTERN = "^# (?<title>.+)$";
    const one = chunkOf("One", "same");
    const two = chunkOf("Two", "edited");
    m.getStoredHashes.mockResolvedValue(new Map([[one.chunk_id, one.content_hash], [two.chunk_id, "stale-hash"]]));
    await runIngest();
    expect(m.embedTexts).toHaveBeenCalledOnce();
    expect(m.embedTexts.mock.calls[0][0]).toEqual([embedInput(two)]);
    expect(m.upsertChunks.mock.calls[0][0].map((c: { story_id: string }) => c.story_id)).toEqual(["two"]);
    expect(lastIngestLog()).toMatchObject({ stories: 2, embedded: 1, skipped: 1 });
  });

  it("makes no embedding call at all when everything is unchanged", async () => {
    files["a.md"] = story("One", "same");
    const one = chunkOf("One", "same");
    m.getStoredHashes.mockResolvedValue(new Map([[one.chunk_id, one.content_hash]]));
    await runIngest();
    expect(m.embedTexts).not.toHaveBeenCalled();
    expect(m.upsertChunks).not.toHaveBeenCalled();
    expect(lastIngestLog()).toMatchObject({ embedded: 0, skipped: 1 });
  });

  it("works in batches of --batch-size", async () => {
    files["a.md"] = ["# A", "a", "# B", "b", "# C", "c"];
    process.env.STORY_HEADER_PATTERN = "^# (?<title>.+)$";
    await runIngest("--batch-size", "2");
    expect(m.getStoredHashes.mock.calls.map((c) => c[0].length)).toEqual([2, 1]);
    expect(m.embedTexts.mock.calls.map((c) => c[0].length)).toEqual([2, 1]);
  });

  it("passes --rebuild to the Milvus collection setup", async () => {
    files["a.md"] = story("One", "text");
    await runIngest("--rebuild");
    expect(m.ensureCollection).toHaveBeenCalledWith(true);
    expect(lastIngestLog().rebuild).toBe(true);
  });
});

describe("stale rows and odd files", () => {
  it("deletes rows for stories that vanished from a file, and only those", async () => {
    files["a.md"] = story("One", "text");
    const one = chunkOf("One", "text");
    m.listChunkIdsBySource.mockResolvedValue([one.chunk_id, "story-gone"]);
    await runIngest();
    expect(m.listChunkIdsBySource).toHaveBeenCalledWith("a.md");
    expect(m.deleteChunks).toHaveBeenCalledWith(["story-gone"]);
    expect(lastIngestLog().stale_deleted).toBe(1);
  });

  it("deletes stale rows in groups of 100", async () => {
    files["a.md"] = story("One", "text");
    m.listChunkIdsBySource.mockResolvedValue(Array.from({ length: 250 }, (_, i) => `story-old-${i}`));
    await runIngest();
    expect(m.deleteChunks.mock.calls.map((c) => c[0].length)).toEqual([100, 100, 50]);
  });

  it("leaves a file that yields no stories untouched, but carries on with the others", async () => {
    files["empty.md"] = [""];
    files["b.md"] = story("Two", "text");
    await runIngest();
    expect(m.listChunkIdsBySource).toHaveBeenCalledTimes(1);
    expect(m.listChunkIdsBySource).toHaveBeenCalledWith("b.md");
    expect(lastIngestLog()).toMatchObject({ files: 2, stories: 1 });
  });

  it("fails when no file yields a story", async () => {
    files["empty.md"] = [""];
    await expect(runIngest()).rejects.toThrow(/No stories found in any file/);
    expect(lastIngestLog().error).toBe("Error");
  });

  it("refuses duplicate ids across files, before they could overwrite each other", async () => {
    files["a.md"] = story("Same Title", "one");
    files["b.md"] = story("Same Title", "two");
    await expect(runIngest()).rejects.toThrow(/Duplicate id "story-same-title"/);
    expect(m.upsertChunks).toHaveBeenCalledTimes(1); // only the first file was stored
  });
});

describe("Elasticsearch (optional)", () => {
  it("does nothing with Elasticsearch when ELASTICSEARCH_URL is unset", async () => {
    files["a.md"] = story("One", "text");
    await runIngest();
    for (const fn of [m.pingEs, m.ensureEsIndex, m.indexChunks, m.deleteStaleEs]) expect(fn).not.toHaveBeenCalled();
    expect(lastIngestLog()).toMatchObject({ es_indexed: 0, es_stale_removed: 0 });
  });

  it("checks Elasticsearch before any paid work, indexes every chunk, and removes stale documents", async () => {
    process.env.ELASTICSEARCH_URL = "http://localhost:9200";
    files["a.md"] = story("One", "text");
    const one = chunkOf("One", "text");
    m.getStoredHashes.mockResolvedValue(new Map([[one.chunk_id, one.content_hash]])); // nothing to embed
    m.deleteStaleEs.mockResolvedValue(2);
    await runIngest("--rebuild");
    expect(m.pingEs.mock.invocationCallOrder[0]).toBeLessThan(m.ensureCollection.mock.invocationCallOrder[0]);
    expect(m.ensureEsIndex).toHaveBeenCalledWith(true);
    expect(m.indexChunks.mock.calls[0][0]).toHaveLength(1); // indexed even though unchanged in Milvus
    expect(m.deleteStaleEs).toHaveBeenCalledWith("a.md", [one.chunk_id]);
    expect(lastIngestLog()).toMatchObject({ es_indexed: 1, es_stale_removed: 2, embedded: 0 });
  });

  it("stops before any embedding if Elasticsearch is down", async () => {
    process.env.ELASTICSEARCH_URL = "http://localhost:9200";
    files["a.md"] = story("One", "text");
    m.pingEs.mockRejectedValue(new Error("es unreachable"));
    await expect(runIngest()).rejects.toThrow("es unreachable");
    expect(m.embedTexts).not.toHaveBeenCalled();
    expect(m.ensureCollection).not.toHaveBeenCalled();
  });
});

describe("activity log and cleanup", () => {
  it("logs counts, timings and the error name only, never titles, text or messages", async () => {
    files["a.md"] = story("Distinctive Sample Title", "distinctive sample body");
    m.embedTexts.mockRejectedValue(new Error("failed while embedding Distinctive Sample Title"));
    await expect(runIngest()).rejects.toThrow();
    const record = lastIngestLog();
    expect(record.error).toBe("Error");
    expect(JSON.stringify(record)).not.toMatch(/distinctive/i);
    expect(typeof record.ms).toBe("number");
  });

  it("always closes the Milvus and Elasticsearch connections, on success and on failure", async () => {
    files["a.md"] = story("One", "text");
    await runIngest();
    expect(m.closeConnection).toHaveBeenCalledTimes(1);
    expect(m.closeEs).toHaveBeenCalledTimes(1);
    m.embedTexts.mockRejectedValue(new Error("x"));
    await expect(runIngest()).rejects.toThrow();
    expect(m.closeConnection).toHaveBeenCalledTimes(2);
    expect(m.closeEs).toHaveBeenCalledTimes(2);
  });
});
