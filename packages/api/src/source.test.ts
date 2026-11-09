import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const extractLines = vi.fn();
vi.mock("./pdf.js", () => ({ extractLines }));

const { listSourceFiles, loadLines } = await import("./source.js");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "story-source-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const touch = (rel: string, content = "x") => {
  fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
};

describe("listSourceFiles", () => {
  it("finds .pdf, .txt and .md at any depth, sorted, matching extensions case-insensitively", () => {
    touch("b.txt");
    touch("a.MD");
    touch("sub/deep/c.pdf");
    expect(listSourceFiles(dir)).toEqual(["a.MD", "b.txt", path.join("sub", "deep", "c.pdf")]);
  });

  it("skips other file types and hidden files and folders", () => {
    touch("notes.docx");
    touch("questions.json");
    touch(".hidden.txt");
    touch(".story-search/cache.md");
    touch("keep.md");
    expect(listSourceFiles(dir)).toEqual(["keep.md"]);
  });

  it("returns an empty list for an empty folder", () => {
    expect(listSourceFiles(dir)).toEqual([]);
  });
});

describe("loadLines", () => {
  it("splits .txt and .md on LF and CRLF and trims trailing spaces", async () => {
    touch("a.txt", "one  \r\ntwo\nthree\t");
    expect(await loadLines(dir, "a.txt")).toEqual(["one", "two", "three"]);
  });

  it("sends PDFs to the PDF extractor", async () => {
    extractLines.mockResolvedValue(["from pdf"]);
    expect(await loadLines(dir, "doc.PDF")).toEqual(["from pdf"]);
    expect(extractLines).toHaveBeenCalledWith(path.join(dir, "doc.PDF"));
  });
});
