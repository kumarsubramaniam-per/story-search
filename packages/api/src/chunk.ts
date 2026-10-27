import { createHash } from "node:crypto";

export type Chunk = {
  chunk_id: string;
  story_id: string;
  title: string;
  text: string;
  source_file: string;
  content_hash: string;
};

// A story starts with a header line like "A1 - PayPal.com Rebuild".
const HEADER = /^([A-Z]\d+) - (.+)$/;
// The title can wrap onto extra lines; the body starts at this line.
const BODY_START = /^Representative question:/;

/** Splits the PDF's lines into one chunk per story. Anything before the first header (cover page) is ignored. */
export function chunkStories(lines: string[], sourceFile: string): Chunk[] {
  const stories: { story_id: string; titleLines: string[]; bodyLines: string[]; inBody: boolean }[] = [];

  for (const line of lines) {
    const header = HEADER.exec(line);
    if (header) {
      stories.push({ story_id: header[1], titleLines: [header[2]], bodyLines: [], inBody: false });
      continue;
    }
    const current = stories.at(-1);
    if (!current) continue;
    if (!current.inBody && BODY_START.test(line)) current.inBody = true;
    (current.inBody ? current.bodyLines : current.titleLines).push(line);
  }

  return stories.map((s) => {
    const title = s.titleLines.join(" ");
    const text = s.bodyLines.join("\n");
    return {
      chunk_id: `story-${s.story_id.toLowerCase()}`,
      story_id: s.story_id,
      title,
      text,
      source_file: sourceFile,
      // Hash covers title + text (the exact string we embed), so a title edit also triggers re-embedding.
      content_hash: createHash("sha256").update(embedInput({ title, text })).digest("hex"),
    };
  });
}

/** The string that gets embedded: the title helps retrieval, so it goes in front of the body. */
export function embedInput(c: Pick<Chunk, "title" | "text">): string {
  return `${c.title}\n\n${c.text}`;
}
