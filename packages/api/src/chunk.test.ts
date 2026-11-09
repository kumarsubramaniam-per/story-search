import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkStories, embedInput, slugify, CHUNK_ID_MAX_LENGTH, STORY_ID_MAX_LENGTH } from "./chunk.js";

afterEach(() => vi.restoreAllMocks());

describe("slugify", () => {
  it("lowercases, drops accents and collapses punctuation into single hyphens", () => {
    expect(slugify("Some Title!", 40)).toBe("some-title");
    expect(slugify("  Café -- Déjà   vu  ", 40)).toBe("cafe-deja-vu");
  });

  it("cuts to the max length without leaving a trailing hyphen", () => {
    expect(slugify("alpha beta gamma", 6)).toBe("alpha");
    expect(slugify("a".repeat(50), 10)).toHaveLength(10);
  });

  it("falls back to a short stable hash when nothing latin is left", () => {
    const a = slugify("日本語", 32);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(slugify("日本語", 32)).toBe(a);
    expect(slugify("中文", 32)).not.toBe(a);
  });
});

describe("chunkStories without a header pattern (one story per file)", () => {
  it("takes the first non-empty line as the title and strips markdown # marks", () => {
    const [c] = chunkStories(["", "# A Sample Note", "First line.", "Second line."], "notes/a.md");
    expect(c.title).toBe("A Sample Note");
    expect(c.text).toBe("First line.\nSecond line.");
    expect(c.story_id).toBe("a-sample-note");
    expect(c.chunk_id).toBe("story-a-sample-note");
    expect(c.source_file).toBe("notes/a.md");
  });

  it("returns nothing for an empty file", () => {
    expect(chunkStories(["", "  ", ""], "empty.txt")).toEqual([]);
  });

  it("skips (and warns about) a file that has a title but no text", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(chunkStories(["Only a title", "", "  "], "t.txt")).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("chunkStories with a header pattern", () => {
  const headerPattern = /^## (?<title>.+)$/;

  it("splits one file into several stories and ignores text before the first header", () => {
    const lines = ["Cover page text", "## First", "body one", "", "## Second", "body two"];
    const chunks = chunkStories(lines, "f.md", { headerPattern });
    expect(chunks.map((c) => [c.story_id, c.text])).toEqual([
      ["first", "body one"],
      ["second", "body two"],
    ]);
  });

  it("uses the (?<id>) group as the story id when the pattern has one", () => {
    const chunks = chunkStories(["X12 - Sample Title", "text"], "f.txt", { headerPattern: /^(?<id>[A-Z]\d+) - (?<title>.+)$/ });
    expect(chunks[0].story_id).toBe("X12");
    expect(chunks[0].title).toBe("Sample Title");
    expect(chunks[0].chunk_id).toBe("story-x12");
  });

  it("throws a clear error when the pattern has no title group", () => {
    expect(() => chunkStories(["## x", "body"], "f.md", { headerPattern: /^## (.+)$/ })).toThrow(/title/);
  });

  it("joins a wrapped title until the body-start pattern matches", () => {
    const lines = ["## A long title that", "wraps onto a second line", "Body: the text starts here", "more text"];
    const [c] = chunkStories(lines, "f.md", { headerPattern, bodyStartPattern: /^Body:/ });
    expect(c.title).toBe("A long title that wraps onto a second line");
    expect(c.text).toBe("Body: the text starts here\nmore text");
  });

  it("skips a section with no body but keeps its neighbours", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const chunks = chunkStories(["## Empty", "## Full", "text"], "f.md", { headerPattern });
    expect(chunks.map((c) => c.story_id)).toEqual(["full"]);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("chunk ids and hashes", () => {
  it("keeps ids within the Milvus column widths", () => {
    const [c] = chunkStories([`# ${"word ".repeat(60)}`, "text"], "f.md");
    expect(c.story_id.length).toBeLessThanOrEqual(STORY_ID_MAX_LENGTH);
    expect(c.chunk_id.length).toBeLessThanOrEqual(CHUNK_ID_MAX_LENGTH);
  });

  it("hashes title and text, so an edit to either changes the hash and an identical story does not", () => {
    const hash = (lines: string[]) => chunkStories(lines, "f.md")[0].content_hash;
    const base = hash(["# T", "body"]);
    expect(hash(["# T", "body"])).toBe(base);
    expect(hash(["# T", "body changed"])).not.toBe(base);
    expect(hash(["# T2", "body"])).not.toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
  });

  it("embeds the title in front of the body", () => {
    expect(embedInput({ title: "T", text: "body" })).toBe("T\n\nbody");
  });
});
