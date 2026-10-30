import "./env.js";
import OpenAI from "openai";
import { getEncoding } from "js-tiktoken";
import { timed, addToRequest } from "./activity.js";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMS = 1536;

// Guardrails (spec §8): reject before spending anything.
const MAX_TOKENS_PER_INPUT = 8191; // the model's own input limit
const MAX_TOKENS_PER_REQUEST = 100_000; // well under OpenAI's per-request cap
const MAX_TOKENS_PER_RUN = 500_000; // ~$0.01 at text-embedding-3-small prices; a hard stop for the whole run

// text-embedding-3-small uses the cl100k_base tokenizer.
const encoder = getEncoding("cl100k_base");

// Reads OPENAI_API_KEY from the environment. maxRetries: 0 so a failure can never silently repeat paid calls.
const openai = new OpenAI({ maxRetries: 0 });

let runningTotalTokens = 0;

/** Tokens billed for embeddings so far in this process (the ingest summary logs it). */
export function totalEmbeddingTokens(): number {
  return runningTotalTokens;
}

/** Embeds one batch of texts in a single API request; returns vectors in the same order as the input. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const counts = texts.map((t) => encoder.encode(t).length);
  const total = counts.reduce((a, b) => a + b, 0);
  const tooBig = counts.findIndex((n) => n > MAX_TOKENS_PER_INPUT);
  if (tooBig !== -1) throw new Error(`Input ${tooBig} has ${counts[tooBig]} tokens (limit ${MAX_TOKENS_PER_INPUT})`);
  if (total > MAX_TOKENS_PER_REQUEST) throw new Error(`Batch has ${total} tokens (ceiling ${MAX_TOKENS_PER_REQUEST})`);
  if (runningTotalTokens + total > MAX_TOKENS_PER_RUN) {
    throw new Error(`Run would reach ${runningTotalTokens + total} tokens (ceiling ${MAX_TOKENS_PER_RUN}); stopping`);
  }

  const res = await timed("embed", () =>
    openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: texts,
      dimensions: EMBEDDING_DIMS,
    }),
  );

  // usage is what OpenAI actually billed; compare it with our pre-count.
  runningTotalTokens += res.usage.total_tokens;
  addToRequest("embedding_tokens", res.usage.total_tokens);
  console.log(
    `Embeddings: ${texts.length} inputs, ${res.usage.total_tokens} tokens billed (pre-count ${total}), running total ${runningTotalTokens}`,
  );

  // The API returns items tagged with their input index; sort to be safe.
  return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}
