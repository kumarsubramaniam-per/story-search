import "./env.js";
import fs from "node:fs";
import path from "node:path";
import { extractLines } from "./pdf.js";
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

// Usage: tsx src/ingest.ts [--dry-run] [--rebuild] [--batch-size N]
//   --dry-run     parse and chunk only; no OpenAI or Milvus calls
//   --rebuild     drop and recreate the Milvus collection first
//   --batch-size  chunks per hash-lookup / embedding request / upsert (default 50)
const dryRun = process.argv.includes("--dry-run");
const rebuild = process.argv.includes("--rebuild");
const batchFlag = process.argv.indexOf("--batch-size");
const batchSize = batchFlag === -1 ? 50 : Number(process.argv[batchFlag + 1]);
if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("--batch-size needs a positive integer");

const storiesDir = process.env.STORIES_DIR;
if (!storiesDir) throw new Error("STORIES_DIR is not set in .env");

const pdfs = fs.readdirSync(storiesDir).filter((f) => f.toLowerCase().endsWith(".pdf"));
if (pdfs.length === 0) throw new Error("No PDF found in STORIES_DIR");

try {
  if (!dryRun) await ensureCollection(rebuild);

  // One file at a time, so memory stays flat however many files there are.
  for (const file of pdfs) {
    const chunks = chunkStories(await extractLines(path.join(storiesDir, file)), file);

    // Only ids, titles and word counts are printed, never story text.
    console.log(`${file}: ${chunks.length} stories`);
    for (const c of chunks) {
      console.log(`  ${c.story_id.padEnd(3)} ${String(c.text.split(/\s+/).length).padStart(5)} words  ${c.title}`);
    }
    // A parse that finds nothing is more likely a format problem than an emptied file; never act on it.
    if (chunks.length === 0) throw new Error(`No stories found in ${file}; refusing to continue`);
    if (dryRun) continue;

    await ingestFile(file, chunks);
  }
  if (dryRun) console.log("Dry run: no API or Milvus calls made.");
} finally {
  await milvus.closeConnection();
}

async function ingestFile(file: string, chunks: Chunk[]): Promise<void> {
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
