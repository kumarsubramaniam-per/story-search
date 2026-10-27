import { createHash } from "node:crypto";

export type Chunk = {
  chunk_id: string;
  story_id: string;
  title: string;
  text: string;
  source_file: string;
  content_hash: string;
};

// Column widths in the Milvus schema (milvus.ts); derived ids are cut to fit.
export const STORY_ID_MAX_LENGTH = 32;
export const CHUNK_ID_MAX_LENGTH = 64;

export type ChunkOptions = {
  // Splits a file into several stories. Each matching line starts a story. Named groups:
  // (?<title>...) is required; (?<id>...) is optional (without it the id is made from the title).
  // Example: ^## (?<title>.+)$   or   ^(?<id>[A-Z]\d+) - (?<title>.+)$
  // Unset: each file is one story.
  headerPattern?: RegExp;
  // If set, lines after a header are treated as a wrapped title until one matches this pattern; that line
  // starts the body. Unset: the body starts on the line after the header.
  bodyStartPattern?: RegExp;
};

/** "Some Title!" -> "some-title": lowercase letters, digits and single hyphens only. */
export function slugify(text: string, maxLength: number): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // drop accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  // A title with no latin letters or digits would give an empty slug; fall back to a short hash of the text.
  return slug || createHash("sha256").update(text).digest("hex").slice(0, 8);
}

type Section = { id?: string; titleLines: string[]; bodyLines: string[]; inBody: boolean };

function splitSections(lines: string[], { headerPattern, bodyStartPattern }: ChunkOptions): Section[] {
  if (!headerPattern) {
    // One story per file: the first non-empty line is the title (markdown "#" marks removed), the rest is the body.
    const first = lines.findIndex((l) => l.trim() !== "");
    if (first === -1) return [];
    return [{ titleLines: [lines[first].trim().replace(/^#+\s*/, "")], bodyLines: lines.slice(first + 1), inBody: true }];
  }

  const sections: Section[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const header = headerPattern.exec(line);
    if (header) {
      if (!header.groups?.title) throw new Error("STORY_HEADER_PATTERN must have a (?<title>...) group");
      sections.push({
        id: header.groups.id?.trim(),
        titleLines: [header.groups.title.trim()],
        bodyLines: [],
        inBody: !bodyStartPattern,
      });
      continue;
    }
    const current = sections.at(-1);
    if (!current) continue; // text before the first header (a cover page, say) is ignored
    if (!current.inBody && bodyStartPattern?.test(line)) current.inBody = true;
    if (current.inBody) current.bodyLines.push(raw);
    else current.titleLines.push(line);
  }
  return sections;
}

/** Splits a file's lines into stories, one chunk each. Ids come from the (?<id>) group if given, else from the title. */
export function chunkStories(lines: string[], sourceFile: string, options: ChunkOptions = {}): Chunk[] {
  const chunks: Chunk[] = [];
  for (const section of splitSections(lines, options)) {
    const title = section.titleLines.join(" ");
    const text = section.bodyLines.join("\n").trim();
    const story_id = section.id || slugify(title, STORY_ID_MAX_LENGTH);
    if (!text) {
      console.warn(`Skipping "${story_id}" in ${sourceFile}: it has a title but no text.`);
      continue;
    }
    chunks.push({
      chunk_id: `story-${slugify(story_id, CHUNK_ID_MAX_LENGTH - "story-".length)}`,
      story_id,
      title,
      text,
      source_file: sourceFile,
      // Hash covers title + text (the exact string we embed), so a title edit also triggers re-embedding.
      content_hash: createHash("sha256").update(embedInput({ title, text })).digest("hex"),
    });
  }
  return chunks;
}

/** The string that gets embedded: the title helps retrieval, so it goes in front of the body. */
export function embedInput(c: Pick<Chunk, "title" | "text">): string {
  return `${c.title}\n\n${c.text}`;
}
