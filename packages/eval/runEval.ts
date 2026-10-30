import "../api/src/env.js";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { embedTexts, EMBEDDING_MODEL } from "../api/src/embed.js";
import { searchByVector, getMinScore } from "../api/src/searchMilvus.js";
import { askQuestion, type AskResult } from "../api/src/rag.js";
import { search, SEARCH_MODES, type SearchMode } from "../api/src/search.js";
import { closeEs } from "../api/src/searchEs.js";
import { milvus } from "../api/src/milvus.js";

// Usage: npm run eval -- [--mode vector|keyword] [--via direct|http] [--ask] [--no-cache] [--api http://127.0.0.1:3000]
//   --mode      how stories are found: vector (default) or keyword (needs ELASTICSEARCH_URL). hybrid arrives in milestone 7
//   --via       direct (default) calls the search code in-process; query embeddings are cached on disk
//               http calls a running server (npm run api); the server embeds each query
//   --ask       test the RAG answers instead of search: one paid chat call per question (~$0.0035 each)
//   --no-cache  direct vector mode: re-embed every question instead of using the cache
const TOP_K = 3;
const TARGET = 8; // spec §7: expected story in the top 3 for at least 8 of 10

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const via = option("--via", "direct");
const mode = option("--mode", "vector") as SearchMode; // explicit default, so the result doesn't depend on SEARCH_MODE
const apiUrl = option("--api", "http://127.0.0.1:3000");
if (via !== "direct" && via !== "http") throw new Error("--via must be direct or http");
if (!SEARCH_MODES.includes(mode)) throw new Error(`--mode must be one of: ${SEARCH_MODES.join(", ")}`);
// Keyword search needs no query vectors, so only vector mode embeds the questions (and uses the cache).
const needsVectors = via === "direct" && mode === "vector";

const storiesDir = process.env.STORIES_DIR;
if (!storiesDir) throw new Error("STORIES_DIR is not set in .env");

// Questions live with the private stories, outside the repo.
type Question = { id: string; question: string; expected_story_id: string };
// Negative cases are questions the stories can't answer: a good answer says "not found".
type NegativeCase = { id: string; question: string };
const { questions, negative_cases: negatives = [] } = JSON.parse(
  fs.readFileSync(path.join(storiesDir, "questions.json"), "utf8"),
) as { questions: Question[]; negative_cases?: NegativeCase[] };

type Hit = { story_id: string; score: number };

// An id may be written with or without the "story-" prefix; compare them the same way.
const norm = (id: string) => id.toLowerCase().replace(/^story-/, "");

// --- direct vector mode: embed (with a disk cache), then search by vector -------------------------

// The cache is keyed by sha256(model + question), so it holds vectors only, no question text,
// and changing the model or editing a question automatically misses. It sits outside the repo, in a hidden
// folder so generated files never get mixed up with the user's own files in STORIES_DIR.
const cacheDir = path.join(storiesDir, ".story-search");
const cachePath = path.join(cacheDir, "eval-embeddings.json");
const cacheKey = (q: string) => createHash("sha256").update(`${EMBEDDING_MODEL}:${q}`).digest("hex");

// Returns vectors keyed by question text, so different question lists can share one cache.
async function embedQuestions(qs: { question: string }[]): Promise<{ vectors: Map<string, number[]>; note: string }> {
  let cache: Record<string, number[]> = {};
  if (!flag("--no-cache") && fs.existsSync(cachePath)) {
    try {
      cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    } catch {
      console.warn("Embedding cache is unreadable; ignoring it and re-embedding.");
    }
  }

  const missing = qs.filter((q) => !cache[cacheKey(q.question)]);
  if (missing.length > 0) {
    // One request for all misses (this is the only paid call in the eval).
    const embeddings = await embedTexts(missing.map((q) => q.question));
    missing.forEach((q, i) => (cache[cacheKey(q.question)] = embeddings[i]));
    // Write to a temp file, then rename over the cache: a crash mid-write can't leave a half-written cache.
    fs.mkdirSync(cacheDir, { recursive: true });
    const tmpPath = `${cachePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(cache));
    fs.renameSync(tmpPath, cachePath);
  }
  const vectors = new Map(qs.map((q) => [q.question, cache[cacheKey(q.question)]]));
  return { vectors, note: `cache: ${qs.length - missing.length}/${qs.length} hits, embedded ${missing.length}` };
}

// --- via http: ask the running server ----------------------------------------------------------------

async function searchHttp(question: string): Promise<Hit[]> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/search?q=${encodeURIComponent(question)}&k=${TOP_K}&mode=${mode}`);
  } catch {
    throw new Error(`Could not reach ${apiUrl}. Is the server running? Start it with: npm run api`);
  }
  if (!res.ok) throw new Error(`/search returned ${res.status}`);
  return ((await res.json()) as { results: Hit[] }).results;
}

async function askHttp(question: string): Promise<AskResult> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question, k: TOP_K, mode }),
    });
  } catch {
    throw new Error(`Could not reach ${apiUrl}. Is the server running? Start it with: npm run api`);
  }
  if (!res.ok) throw new Error(`/ask returned ${res.status}`);
  return (await res.json()) as AskResult;
}

// --- run ---------------------------------------------------------------------------------------------

async function runSearchEval(vectors: Map<string, number[]>): Promise<void> {
  const minScore = getMinScore(); // a cosine threshold: applies to vector mode only
  let inTop = 0;
  let first = 0;
  let weakest: { id: string; score: number } | undefined; // lowest score among the correct matches
  for (const q of questions) {
    // Direct vector mode searches without the threshold, then applies MIN_SCORE here exactly as the app does, so
    // the raw scores stay available for the gap report below. Over http the server has already applied it.
    const raw = needsVectors
      ? await searchByVector(vectors.get(q.question)!, TOP_K, null)
      : via === "direct"
        ? await search(q.question, TOP_K, mode)
        : await searchHttp(q.question);
    const hits = needsVectors ? raw.filter((h) => minScore === null || h.score >= minScore) : raw;
    const rank = hits.findIndex((h) => norm(h.story_id) === norm(q.expected_story_id)) + 1; // 0 = not found
    if (rank > 0) inTop++;
    if (rank === 1) first++;
    if (rank > 0 && (!weakest || hits[rank - 1].score < weakest.score)) weakest = { id: q.id, score: hits[rank - 1].score };

    // Only ids, ranks and scores are printed, never question or story text.
    const top = hits.map((h) => `${h.story_id}(${h.score.toFixed(2)})`).join(" ");
    console.log(
      `${q.id.padEnd(5)} expected ${q.expected_story_id.padEnd(4)} got ${top.padEnd(36)} ${rank ? `rank ${rank}` : "miss  "}  ${rank ? "PASS" : "FAIL"}`,
    );
  }

  console.log(`\n${inTop}/${questions.length} expected story in top ${TOP_K} (target >= ${TARGET}); ${first} ranked first`);
  if (inTop < TARGET) process.exitCode = 1;

  // Help choose MIN_SCORE: it should sit between the strongest negative-case match and the weakest correct match.
  if (needsVectors) {
    let strongestNegative: { id: string; score: number } | undefined;
    for (const n of negatives) {
      const [top] = await searchByVector(vectors.get(n.question)!, 1, null);
      if (top && (!strongestNegative || top.score > strongestNegative.score)) strongestNegative = { id: n.id, score: top.score };
    }
    const fmt = (m?: { id: string; score: number }) => (m ? `${m.score.toFixed(2)} (${m.id})` : "n/a");
    console.log(
      `\nScore gap: weakest correct match ${fmt(weakest)}; strongest negative-case match ${fmt(strongestNegative)}; ` +
        `MIN_SCORE ${minScore ?? "unset"}`,
    );
    if (weakest && strongestNegative) {
      console.log(
        weakest.score > strongestNegative.score
          ? `A MIN_SCORE between ${strongestNegative.score.toFixed(2)} and ${weakest.score.toFixed(2)} keeps every correct match and drops the negative cases.`
          : "No clean threshold: a negative case scores as high as a correct match.",
      );
    }
  }
}

// Ask eval: does each answer cite the expected story, and do negative cases get "not found"?
// Only ids, flags and token counts are printed, never answer, question or story text.
async function runAskEval(vectors: Map<string, number[]>): Promise<void> {
  const ask = (q: string) => (via === "direct" ? askQuestion(q, TOP_K, vectors.get(q), mode) : askHttp(q));
  let correct = 0;
  let invalid = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const models = new Set<string>();
  const tally = (r: AskResult) => {
    if (r.model) models.add(r.model); // empty when the chat call was skipped (no story above MIN_SCORE)
    invalid += r.invalidCitations.length;
    tokensIn += r.usage.prompt_tokens;
    tokensOut += r.usage.completion_tokens;
  };
  const flags = (r: AskResult) =>
    `${r.invalidCitations.length ? ` INVALID-CITES(${r.invalidCitations.join(",")})` : ""}${r.truncated ? " TRUNCATED" : ""}`;

  for (const q of questions) {
    const r = await ask(q.question);
    tally(r);
    const ok = r.found && r.cited.some((id) => norm(id) === norm(q.expected_story_id));
    if (ok) correct++;
    console.log(
      `${q.id.padEnd(5)} expected ${q.expected_story_id.padEnd(4)} cited ${(r.cited.join(",") || "-").padEnd(10)} ` +
        `found ${r.found ? "yes" : "no "} tokens ${r.usage.prompt_tokens}/${r.usage.completion_tokens}  ${ok ? "PASS" : "FAIL"}${flags(r)}`,
    );
  }

  let negCorrect = 0;
  for (const n of negatives) {
    const r = await ask(n.question);
    tally(r);
    const ok = !r.found;
    if (ok) negCorrect++;
    console.log(
      `${n.id.padEnd(5)} negative case; expected "not found"  found ${r.found ? "yes" : "no "} ` +
        `cited ${r.cited.join(",") || "-"} tokens ${r.usage.prompt_tokens}/${r.usage.completion_tokens}  ${ok ? "PASS" : "FAIL"}${flags(r)}`,
    );
  }

  console.log(
    `\n${correct}/${questions.length} answers cite the expected story (target >= ${TARGET}); ` +
      `${negCorrect}/${negatives.length} negative cases answered "not found"; ${invalid} invalid citations`,
  );
  console.log(`Chat model: ${[...models].join(", ")}; tokens used: ${tokensIn} in / ${tokensOut} out`);
  if (correct < TARGET || negCorrect < negatives.length || invalid > 0) process.exitCode = 1;
}

try {
  const asking = flag("--ask");
  const toEmbed = [...questions, ...negatives]; // negatives are needed for the score-gap report too
  let vectors = new Map<string, number[]>();
  let note = via === "http" ? "embedded server-side, no cache" : "no query embeddings needed";
  if (needsVectors) ({ vectors, note } = await embedQuestions(toEmbed));

  console.log(
    `Eval${asking ? " (ask)" : ""}: ${asking ? toEmbed.length : questions.length} questions, via=${via}, mode=${mode}, top ${TOP_K} (${note})`,
  );
  if (needsVectors) console.log(`Cache file: ${cachePath}`);
  console.log();

  await (asking ? runAskEval(vectors) : runSearchEval(vectors));
} finally {
  await milvus.closeConnection();
  await closeEs();
}
