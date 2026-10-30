import { Client } from "@elastic/elasticsearch";
import type { Chunk } from "./chunk.js";
import type { SearchHit } from "./searchMilvus.js";

export const ES_INDEX = "stories";
const SNIPPET_CHARS = 300;
const BULK_SIZE = 200;

/** ELASTICSEARCH_URL from .env, e.g. http://localhost:9200. Unset means Elasticsearch is off (null). */
export function getEsUrl(): string | null {
  return process.env.ELASTICSEARCH_URL?.trim() || null;
}

/**
 * How text is split into searchable terms, for indexing and for queries. `english` also stems words (scaling and
 * scaled match each other) and drops common words; use another built-in analyzer name for other languages.
 */
export function getAnalyzer(): string {
  return process.env.ELASTICSEARCH_ANALYZER?.trim() || "english";
}

let client: Client | undefined;
function es(): Client {
  const node = getEsUrl();
  if (!node) throw new Error("ELASTICSEARCH_URL is not set in .env");
  // maxRetries: 0 so an outage fails fast instead of hanging behind silent retries.
  client ??= new Client({ node, requestTimeout: 30_000, maxRetries: 0 });
  return client;
}

export async function closeEs(): Promise<void> {
  await client?.close();
}

/** Throws a clear error if Elasticsearch isn't reachable. Ingest calls it first, before any paid API call. */
export async function pingEs(): Promise<void> {
  try {
    await es().ping();
  } catch (err) {
    throw new Error(`Cannot reach Elasticsearch at ${getEsUrl()}: ${(err as Error).message}. Is it running? (npm run dev:up)`);
  }
}

/**
 * Creates the `stories` index if missing. It is recreated when `rebuild` is set or when its analyzer differs from
 * ELASTICSEARCH_ANALYZER. That is cheap: ingest re-indexes every chunk on each run and no embeddings are involved.
 */
export async function ensureEsIndex(rebuild: boolean): Promise<void> {
  const analyzer = getAnalyzer();
  if (await es().indices.exists({ index: ES_INDEX })) {
    const mapping = await es().indices.getMapping({ index: ES_INDEX });
    const current = (mapping[ES_INDEX]?.mappings?.properties?.text as { analyzer?: string } | undefined)?.analyzer;
    if (!rebuild && current === analyzer) return;
    console.log(
      rebuild
        ? "Elasticsearch: recreating the index (--rebuild)."
        : `Elasticsearch: analyzer changed (${current ?? "none"} -> ${analyzer}); recreating the index.`,
    );
    await es().indices.delete({ index: ES_INDEX });
  }

  await es().indices.create({
    index: ES_INDEX,
    // One shard and no replicas: a single local node, so replicas would only leave the index "yellow".
    settings: { number_of_shards: 1, number_of_replicas: 0 },
    mappings: {
      properties: {
        chunk_id: { type: "keyword" },
        story_id: { type: "keyword" },
        source_file: { type: "keyword" },
        content_hash: { type: "keyword" },
        title: { type: "text", analyzer },
        text: { type: "text", analyzer },
      },
    },
  });
}

/** Adds or overwrites chunks, using chunk_id as the document id (same id as the Milvus row). */
export async function indexChunks(chunks: Chunk[]): Promise<void> {
  for (let i = 0; i < chunks.length; i += BULK_SIZE) {
    const operations = chunks.slice(i, i + BULK_SIZE).flatMap((c) => [
      { index: { _index: ES_INDEX, _id: c.chunk_id } },
      {
        chunk_id: c.chunk_id,
        story_id: c.story_id,
        title: c.title,
        text: c.text,
        source_file: c.source_file,
        content_hash: c.content_hash,
      },
    ]);
    // refresh: wait_for makes the documents searchable before this call returns.
    const res = await es().bulk({ operations, refresh: "wait_for" });
    if (res.errors) {
      const failed = res.items.find((item) => item.index?.error);
      throw new Error(`Elasticsearch bulk indexing failed: ${JSON.stringify(failed?.index?.error)}`);
    }
  }
}

/** Deletes documents from `sourceFile` whose id is not in `currentIds` (stories removed from that file). */
export async function deleteStaleEs(sourceFile: string, currentIds: string[]): Promise<number> {
  const res = await es().deleteByQuery({
    index: ES_INDEX,
    refresh: true,
    query: {
      bool: {
        filter: [{ term: { source_file: sourceFile } }],
        must_not: [{ ids: { values: currentIds } }],
      },
    },
  });
  return res.deleted ?? 0;
}

/**
 * Keyword search with BM25: the best-matching stories for the words in `query`. A title match counts three times
 * as much as a text match. Scores start at 0 and have no upper limit, so they are not comparable with cosine scores.
 */
export async function searchKeyword(query: string, k: number): Promise<SearchHit[]> {
  const res = await es().search({
    index: ES_INDEX,
    size: k,
    query: { multi_match: { query, fields: ["title^3", "text"], type: "best_fields" } },
    _source: ["chunk_id", "story_id", "title", "text"],
  });
  return res.hits.hits.map((hit) => {
    const s = hit._source as { chunk_id: string; story_id: string; title: string; text: string };
    return {
      chunk_id: s.chunk_id,
      story_id: s.story_id,
      title: s.title,
      snippet: s.text.slice(0, SNIPPET_CHARS),
      text: s.text,
      score: hit._score ?? 0,
    };
  });
}
