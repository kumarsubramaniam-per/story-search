import "./env.js";
import OpenAI from "openai";
import { getEncoding } from "js-tiktoken";
import { searchByVector, searchStories } from "./searchMilvus.js";

// Guardrails (spec §8): reject before spending, and cap what the model may spend.
const MAX_PROMPT_TOKENS = 12_000; // k=3 is ~3k; this still allows k=10
const MAX_COMPLETION_TOKENS = 1000;

export const NOT_FOUND = "Not found in the collection.";

const SYSTEM_PROMPT = `You answer questions using ONLY the stories given in the context. Each story starts with its id in square brackets.
Rules:
- Use only facts stated in the context. Do not use outside knowledge and do not guess.
- Cite the story behind each claim by its id in square brackets, copied exactly from the context. Only cite ids that appear in the context.
- If the context does not contain the answer, reply exactly: ${NOT_FOUND}
- Be concise: under 200 words.
- Write plain text only: no markdown, so no bold, bullet points or headings.`;

// Chat models since GPT-4o use the o200k_base tokenizer. This is an estimate: the API adds a few tokens of its own.
const encoder = getEncoding("o200k_base");

// Chat Completions API (/v1/chat/completions), never the Responses API (the key isn't allowed to use it).
// maxRetries: 0 so a failure can never silently repeat a paid call.
const openai = new OpenAI({ maxRetries: 0 });

let runningPromptTokens = 0;
let runningCompletionTokens = 0;

export type AskResult = {
  answer: string;
  model: string; // the model that actually answered, as reported by the API
  found: boolean; // false when the model said the stories don't contain the answer
  truncated: boolean; // true if the answer hit the output cap
  cited: string[]; // story ids the answer cites that were really in the context
  invalidCitations: string[]; // ids the answer cites that were NOT in the context (should be empty)
  sources: { chunk_id: string; story_id: string; title: string; score: number }[]; // everything retrieved
  usage: { prompt_tokens: number; completion_tokens: number };
};

/**
 * Finds the story ids an answer cites, written like [id] or [id1, id2]. Ids can have any shape, so a bracketed
 * token counts as a citation if it is a retrieved id; id-like tokens that are not retrieved are reported as invalid.
 */
export function parseCitations(answer: string, retrievedIds: Set<string>): { cited: string[]; invalid: string[] } {
  const cited = new Set<string>();
  const invalid = new Set<string>();
  for (const group of answer.matchAll(/\[([^\]]+)\]/g)) {
    const inner = group[1].trim();
    const tokens = retrievedIds.has(inner) ? [inner] : inner.split(/[,;\s]+/).filter(Boolean);
    for (const token of tokens) {
      if (retrievedIds.has(token)) cited.add(token);
      else if (/^[\w.-]+$/.test(token)) invalid.add(token);
    }
  }
  return { cited: [...cited], invalid: [...invalid] };
}

/** Retrieval-augmented answer: find the k closest stories, then have the chat model answer from them only. */
export async function askQuestion(question: string, k: number, queryVector?: number[]): Promise<AskResult> {
  const model = process.env.CHAT_MODEL;
  if (!model) throw new Error("CHAT_MODEL is not set in .env");

  // Retrieve. A precomputed query vector (the eval's cache) skips the embedding call.
  const hits = queryVector ? await searchByVector(queryVector, k) : await searchStories(question, k);

  const context = hits.map((h) => `[${h.story_id}] ${h.title}\n${h.text}`).join("\n\n---\n\n");
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: `Context:\n\n${context}\n\nQuestion: ${question}` },
  ];

  // Pre-count and reject oversized prompts before sending anything (~4 tokens of overhead per message).
  const preCount = messages.reduce((n, m) => n + encoder.encode(m.content).length + 4, 3);
  if (preCount > MAX_PROMPT_TOKENS) throw new Error(`Prompt is ${preCount} tokens (ceiling ${MAX_PROMPT_TOKENS}); lower k`);

  const res = await openai.chat.completions.create({
    model,
    messages,
    max_completion_tokens: MAX_COMPLETION_TOKENS, // newer models reject the older max_tokens name
    // Reasoning models (gpt-5.x, o-series) can spend hidden tokens thinking; turn that off for a predictable cost.
    // Non-reasoning models (e.g. gpt-4.1-mini) would reject the parameter, so only send it when it applies.
    ...(/^(gpt-5|o\d)/i.test(model) ? { reasoning_effort: "none" as const } : {}),
  });

  const usage = { prompt_tokens: res.usage?.prompt_tokens ?? 0, completion_tokens: res.usage?.completion_tokens ?? 0 };
  runningPromptTokens += usage.prompt_tokens;
  runningCompletionTokens += usage.completion_tokens;
  console.log(
    `Chat: ${usage.prompt_tokens} prompt tokens (pre-count ${preCount}), ${usage.completion_tokens} completion tokens, ` +
      `running total ${runningPromptTokens} in / ${runningCompletionTokens} out`,
  );

  const choice = res.choices[0];
  const answer = (choice.message.content ?? "").trim();

  const { cited, invalid } = parseCitations(answer, new Set(hits.map((h) => h.story_id)));

  return {
    answer,
    model: res.model,
    found: !answer.toLowerCase().startsWith(NOT_FOUND.toLowerCase().replace(/\.$/, "")),
    truncated: choice.finish_reason === "length",
    cited,
    invalidCitations: invalid,
    sources: hits.map((h) => ({ chunk_id: h.chunk_id, story_id: h.story_id, title: h.title, score: h.score })),
    usage,
  };
}
