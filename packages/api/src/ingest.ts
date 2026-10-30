import "./env.js";
import { listSourceFiles, loadLines } from "./source.js";
import { chunkStories, embedInput, type Chunk } from "./chunk.js";
import { embedTexts } from "./embed.js";
import {
  ensureCollection,
  getStoredHashes,
  upsertChunks,
  listChunkIdsBySource,
  deleteChunks,
  milvus,
} from "./milvus.js";
import { getEsUrl, pingEs, ensureEsIndex, indexChunks, deleteStaleEs, closeEs } from "./searchEs.js";

// Usage: tsx src/ingest.ts [--dry-run] [--rebuild] [--batch-size N]
//   --dry-run     parse and chunk only; no OpenAI or Milvus calls
//   --rebuild     drop and recreate the Milvus collection (and the Elasticsearch index) first
//   --batch-size  chunks per hash-lookup / embedding request / upsert (default 50)
//
// Reads every .pdf, .txt and .md file under STORIES_DIR. By default each file is one story; set
// STORY_HEADER_PATTERN (and optionally STORY_BODY_START_PATTERN) in .env to split files into several stories.
const dryRun = process.argv.includes("--dry-run");
const rebuild = process.argv.includes("--rebuild");
const batchFlag = process.argv.indexOf("--batch-size");
const batchSize = batchFlag === -1 ? 50 : Number(process.argv[batchFlag + 1]);
if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("--batch-size needs a positive integer");

const storiesDir = process.env.STORIES_DIR;
if (!storiesDir) throw new Error("STORIES_DIR is not set in .env");

function patternFromEnv(name: string): RegExp | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  try {
    return new RegExp(value);
  } catch {
    throw new Error(`${name} is not a valid regular expression`);
  }
}
const headerPattern = patternFromEnv("STORY_HEADER_PATTERN");
const bodyStartPattern = patternFromEnv("STORY_BODY_START_PATTERN");
if (headerPattern && !headerPattern.source.includes("(?<title>")) {
  throw new Error("STORY_HEADER_PATTERN must contain a (?<title>...) group");
}

const files = listSourceFiles(storiesDir);
if (files.length === 0) throw new Error("No .pdf, .txt or .md files found under STORIES_DIR");

// With ELASTICSEARCH_URL set, stories are also indexed for keyword search (the index is created if missing).
const esEnabled = getEsUrl() !== null;

try {
  if (!dryRun) {
    // Check Elasticsearch first, so an outage stops the run before any paid embedding call.
    if (esEnabled) {
      await pingEs();
      await ensureEsIndex(rebuild);
    }
    await ensureCollection(rebuild);
  }

  // One file at a time, so memory stays flat however many files there are.
  const seenIds = new Map<string, string>(); // chunk_id -> file it came from
  let storyCount = 0;
  for (const file of files) {
    const chunks = chunkStories(await loadLines(storiesDir, file), file, { headerPattern, bodyStartPattern });

    // Two stories with the same id would silently overwrite each other in Milvus.
    for (const c of chunks) {
      const other = seenIds.get(c.chunk_id);
      if (other) throw new Error(`Duplicate id "${c.chunk_id}" (story "${c.title}" in ${file}; first seen in ${other})`);
      seenIds.set(c.chunk_id, file);
    }

    // Only ids, titles and word counts are printed, never story text.
    console.log(`${file}: ${chunks.length} stories`);
    for (const c of chunks) {
      console.log(`  ${c.story_id.padEnd(12)} ${String(c.text.split(/\s+/).length).padStart(5)} words  ${c.title}`);
    }
    // A file that yields nothing is skipped and left untouched: more likely a format mismatch than an emptied file.
    if (chunks.length === 0) {
      console.warn(`  No stories found in ${file}; skipping it (its existing rows, if any, are kept).`);
      continue;
    }
    storyCount += chunks.length;
    if (dryRun) continue;

    await ingestFile(file, chunks);
  }
  if (storyCount === 0) throw new Error("No stories found in any file; check STORY_HEADER_PATTERN");
  if (dryRun) console.log("Dry run: no API or Milvus calls made.");
} finally {
  await milvus.closeConnection();
  await closeEs();
}

async function ingestFile(file: string, chunks: Chunk[]): Promise<void> {
  // Keyword index first: it is free and idempotent, so every run indexes every chunk (no hash check needed).
  // That also fills a newly started Elasticsearch without re-embedding anything.
  if (esEnabled) {
    await indexChunks(chunks);
    const removed = await deleteStaleEs(file, chunks.map((c) => c.chunk_id));
    console.log(`Elasticsearch: ${chunks.length} indexed${removed ? `, ${removed} stale removed` : ""}`);
  }

  let embedded = 0;
  let skipped = 0;

  // Per batch: look up stored hashes -> embed only new/changed -> upsert. A failure loses at most one batch
  // of paid embeddings, and rerunning resumes because finished batches now match their hashes.
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const stored = await getStoredHashes(batch.map((c) => c.chunk_id));
    const changed = batch.filter((c) => stored.get(c.chunk_id) !== c.content_hash);
    skipped += batch.length - changed.length;
    if (changed.length === 0) continue;

    const embeddings = await embedTexts(changed.map(embedInput));
    await upsertChunks(changed, embeddings);
    embedded += changed.length;
  }
  console.log(`${embedded} embedded and upserted, ${skipped} unchanged (skipped)`);

  // Stories that disappeared from this file: delete only rows tagged with this same source_file.
  const current = new Set(chunks.map((c) => c.chunk_id));
  const stale = (await listChunkIdsBySource(file)).filter((id) => !current.has(id));
  for (let i = 0; i < stale.length; i += 100) await deleteChunks(stale.slice(i, i + 100));
  if (stale.length > 0) console.log(`Deleted ${stale.length} stale rows: ${stale.join(", ")}`);
}
