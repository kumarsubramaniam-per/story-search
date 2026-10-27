import fs from "node:fs";
import path from "node:path";
import { extractLines } from "./pdf.js";

const EXTENSIONS = new Set([".pdf", ".txt", ".md"]);

/** Source files under `dir` (any folder depth), as paths relative to `dir`, sorted. Hidden files and folders are skipped. */
export function listSourceFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (relDir: string) => {
    for (const entry of fs.readdirSync(path.join(dir, relDir), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue; // e.g. .story-search/, where generated files go
      const rel = path.join(relDir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (EXTENSIONS.has(path.extname(entry.name).toLowerCase())) found.push(rel);
    }
  };
  walk("");
  return found.sort();
}

/** A file's text as lines: PDFs go through pdf.js (footers stripped); .txt and .md are read as they are. */
export async function loadLines(dir: string, file: string): Promise<string[]> {
  const fullPath = path.join(dir, file);
  if (path.extname(file).toLowerCase() === ".pdf") return extractLines(fullPath);
  return fs.readFileSync(fullPath, "utf8").split(/\r?\n/).map((line) => line.trimEnd());
}
