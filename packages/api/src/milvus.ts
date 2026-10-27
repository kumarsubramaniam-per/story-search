import { MilvusClient, DataType } from "@zilliz/milvus2-sdk-node";
import type { Chunk } from "./chunk.js";
import { EMBEDDING_DIMS } from "./embed.js";

export const COLLECTION = "stories";

export const milvus = new MilvusClient({ address: "localhost:19530" });

// Milvus retries failed writes internally, so a storage problem shows up as a silent stall.
// Fail loudly instead (this happened once when the data folder sat inside iCloud-synced ~/Documents).
export async function withTimeout<T>(p: Promise<T>, label: string, ms = 60_000): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Milvus ${label} timed out after ${ms / 1000}s`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Creates the `stories` collection (schema per spec §5) if missing. With rebuild, drops it first. */
export async function ensureCollection(rebuild: boolean): Promise<void> {
  const collection_name = COLLECTION;
  const exists = (await milvus.hasCollection({ collection_name })).value;

  if (exists && rebuild) {
    await milvus.dropCollection({ collection_name });
  } else if (exists) {
    await milvus.loadCollection({ collection_name });
    return;
  }

  await milvus.createCollection({
    collection_name,
    fields: [
      { name: "chunk_id", data_type: DataType.VarChar, max_length: 64, is_primary_key: true },
      { name: "story_id", data_type: DataType.VarChar, max_length: 32 },
      { name: "title", data_type: DataType.VarChar, max_length: 512 },
      { name: "text", data_type: DataType.VarChar, max_length: 65535 },
      { name: "source_file", data_type: DataType.VarChar, max_length: 512 },
      { name: "embedding", data_type: DataType.FloatVector, dim: EMBEDDING_DIMS },
      { name: "content_hash", data_type: DataType.VarChar, max_length: 64 },
    ],
  });

  // FLAT = exact brute-force search (fine for ~30 vectors); COSINE similarity.
  await milvus.createIndex({
    collection_name,
    field_name: "embedding",
    index_type: "FLAT",
    metric_type: "COSINE",
  });

  // A collection must be loaded into memory before it can be queried or searched.
  await milvus.loadCollection({ collection_name });
}

// Milvus rejects offset + limit above this on a plain query.
const MAX_QUERY_WINDOW = 16384;

/** Returns chunk_id -> content_hash for just the given ids (ids that aren't stored are absent). */
export async function getStoredHashes(chunkIds: string[]): Promise<Map<string, string>> {
  // A primary-key lookup (not a vector search): JSON.stringify gives a quoted, escaped list like ["a","b"].
  const res = await withTimeout(
    milvus.query({
      collection_name: COLLECTION,
      filter: `chunk_id in ${JSON.stringify(chunkIds)}`,
      output_fields: ["chunk_id", "content_hash"],
      limit: chunkIds.length,
    }),
    "hash lookup",
  );
  return new Map(res.data.map((r) => [String(r.chunk_id), String(r.content_hash)]));
}

/** All chunk_ids stored for one source file, read page by page. */
export async function listChunkIdsBySource(sourceFile: string): Promise<string[]> {
  const PAGE = 1000;
  const ids: string[] = [];
  for (let offset = 0; ; offset += PAGE) {
    if (offset + PAGE > MAX_QUERY_WINDOW) {
      throw new Error("Too many rows for offset pagination; switch to queryIterator");
    }
    const res = await withTimeout(
      milvus.query({
        collection_name: COLLECTION,
        filter: `source_file == ${JSON.stringify(sourceFile)}`,
        output_fields: ["chunk_id"],
        limit: PAGE,
        offset,
      }),
      "source listing",
    );
    ids.push(...res.data.map((r) => String(r.chunk_id)));
    if (res.data.length < PAGE) return ids;
  }
}

/** Deletes rows by primary key. */
export async function deleteChunks(chunkIds: string[]): Promise<void> {
  await withTimeout(
    milvus.delete({ collection_name: COLLECTION, filter: `chunk_id in ${JSON.stringify(chunkIds)}` }),
    "delete",
  );
}

/** Inserts new chunks or overwrites existing ones with the same chunk_id. */
export async function upsertChunks(chunks: Chunk[], embeddings: number[][]): Promise<void> {
  await withTimeout(
    milvus.upsert({
      collection_name: COLLECTION,
      data: chunks.map((c, i) => ({ ...c, embedding: embeddings[i] })),
    }),
    "upsert",
  );
}
