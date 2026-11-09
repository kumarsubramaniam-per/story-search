import "./env.js";
import OpenAI from "openai";
import { getEncoding } from "js-tiktoken";
import { search, defaultMode, type SearchMode } from "./search.js";
import { timed } from "./activity.js";

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
  sources: { chunk_id: string; story_id: string; title: string; score: number; ranks?: { vector?: number; keyword?: number } }[]; // everything retrieved
  usage: { prompt_tokens: number; completion_tokens: number };
  mode: SearchMode; // how the stories were retrieved
  noMatches: boolean; // true when retrieval found no story (below MIN_SCORE, or no keyword match): the chat model was not called
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Finds the story ids an answer cites, written like [id] or [id1, id2]. Ids can have any shape (even contain spaces
 * or commas), so each bracket group is searched for the retrieved ids themselves, longest first, wherever they sit
 * between separators (space, comma, semicolon). What is left is split on commas and semicolons; a leftover item
 * with no spaces that contains a letter or digit is reported as an invalid citation, and anything else (a few
 * words of prose, punctuation) is ignored. A leftover single word cannot be told from a made-up id, so prose such
 * as [Smith, 2020] is still reported, and a short retrieved id standing alone between spaces in bracketed prose
 * is credited. Ids that contain a bracket are not supported.
 */
export function parseCitations(answer: string, retrievedIds: Set<string>): { cited: string[]; invalid: string[] } {
  const cited = new Set<string>();
  const invalid = new Set<string>();
  // Longest first, so "G 7" wins over "7". Empty ids are skipped (they would match between any two separators).
  // The patterns depend only on the retrieved ids, so they are built once per answer, not once per bracket group.
  const patterns = [...retrievedIds]
    .filter((id) => id !== "")
    .sort((a, b) => b.length - a.length)
    .map((id) => ({ id, regex: new RegExp(`(?<![^\\s,;])${escapeRegExp(id)}(?![^\\s,;])`, "g") }));
  for (const group of answer.matchAll(/\[([^\]]+)\]/g)) {
    let rest = group[1];
    const found: [position: number, id: string][] = [];
    for (const { id, regex } of patterns) {
      // Blank a match out with commas of the same length, so later ids cannot match inside it and positions hold.
      rest = rest.replace(regex, (match, position: number) => {
        found.push([position, id]);
        return ",".repeat(match.length);
      });
    }
    for (const [, id] of found.sort((a, b) => a[0] - b[0])) cited.add(id); // in the order the answer gives them
    for (const item of rest.split(/\s*[,;]\s*/)) {
      if (item && !/\s/.test(item) && /[\p{L}\p{N}]/u.test(item)) invalid.add(item);
    }
  }
  return { cited: [...cited], invalid: [...invalid] };
}

/** Retrieval-augmented answer: find the k closest stories, then have the chat model answer from them only. */
export async function askQuestion(
  question: string,
  k: number,
  queryVector?: number[],
  mode: SearchMode = defaultMode(),
): Promise<AskResult> {
  const model = process.env.CHAT_MODEL;
  if (!model) throw new Error("CHAT_MODEL is not set in .env");

  // Retrieve. A precomputed query vector (the eval's cache) skips the embedding call in vector mode.
  const hits = await search(question, k, mode, queryVector);

  // Nothing found (below MIN_SCORE, or no keyword match): skip the paid chat call and say so.
  if (hits.length === 0) {
    console.log(`Chat: skipped, no story found (mode ${mode})`);
    return {
      answer: NOT_FOUND,
      mode,
      model: "",
      found: false,
      truncated: false,
      cited: [],
      invalidCitations: [],
      sources: [],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      noMatches: true,
    };
  }

  const context = hits.map((h) => `[${h.story_id}] ${h.title}\n${h.text}`).join("\n\n---\n\n");
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: `Context:\n\n${context}\n\nQuestion: ${question}` },
  ];

  // Pre-count and reject oversized prompts before sending anything (~4 tokens of overhead per message).
  const preCount = messages.reduce((n, m) => n + encoder.encode(m.content).length + 4, 3);
  if (preCount > MAX_PROMPT_TOKENS) throw new Error(`Prompt is ${preCount} tokens (ceiling ${MAX_PROMPT_TOKENS}); lower k`);

  const res = await timed("chat", () =>
    openai.chat.completions.create({
      model,
      messages,
      max_completion_tokens: MAX_COMPLETION_TOKENS, // newer models reject the older max_tokens name
      // Reasoning models (gpt-5.x, o-series) can spend hidden tokens thinking; turn that off for a predictable cost.
      // Non-reasoning models (e.g. gpt-4.1-mini) would reject the parameter, so only send it when it applies.
      ...(/^(gpt-5|o\d)/i.test(model) ? { reasoning_effort: "none" as const } : {}),
    }),
  );

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
    sources: hits.map((h) => ({ chunk_id: h.chunk_id, story_id: h.story_id, title: h.title, score: h.score, ranks: h.ranks })),
    usage,
    mode,
    noMatches: false,
  };
}
