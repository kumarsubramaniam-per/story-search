import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// Silences pdf.js's "standardFontDataUrl" warning when running under Node.
const standardFontDataUrl = fileURLToPath(
  new URL("../../../node_modules/pdfjs-dist/standard_fonts/", import.meta.url),
);

/** Returns the PDF's text as lines, page by page, with repeated headers/footers removed. */
export async function extractLines(pdfPath: string): Promise<string[]> {
  const doc = await getDocument({
    data: new Uint8Array(fs.readFileSync(pdfPath)),
    standardFontDataUrl,
  }).promise;

  const pages: string[][] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();

    // pdf.js returns text fragments with coordinates; group them into lines by y position.
    const rows = new Map<number, [number, string][]>();
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const y = Math.round(item.transform[5]);
      const row = rows.get(y) ?? [];
      row.push([item.transform[4], item.str]);
      rows.set(y, row);
    }
    pages.push(
      [...rows.entries()]
        .sort((a, b) => b[0] - a[0]) // PDF y grows upwards, so descending = top to bottom
        .map(([, row]) =>
          row
            .sort((a, b) => a[0] - b[0])
            .map(([, s]) => s)
            .join(" ")
            .trim(),
        ),
    );
  }

  // A line that appears (ignoring a trailing page number) on at least half the pages
  // is a repeated header/footer, not story text.
  const key = (line: string) => line.replace(/\s*\d+$/, "");
  const pageCount = new Map<string, number>();
  for (const lines of pages) {
    for (const k of new Set(lines.map(key))) pageCount.set(k, (pageCount.get(k) ?? 0) + 1);
  }
  const threshold = Math.max(3, pages.length / 2);

  return pages.flatMap((lines) => lines.filter((l) => (pageCount.get(key(l)) ?? 0) < threshold));
}
