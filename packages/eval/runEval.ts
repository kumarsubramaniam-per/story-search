import "../api/src/env.js";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { embedTexts, EMBEDDING_MODEL } from "../api/src/embed.js";
import { searchByVector } from "../api/src/searchMilvus.js";
import { milvus } from "../api/src/milvus.js";

// Usage: npm run eval -- [--mode direct|http] [--no-cache] [--api http://127.0.0.1:3000]
//   direct (default)  calls the search code in-process; query embeddings are cached on disk
//   http              calls GET /search on a running server (npm run api); the server embeds each query
//   --no-cache        direct mode: re-embed every question instead of using the cache
const TOP_K = 3;
const TARGET = 8; // spec §7: expected story in the top 3 for at least 8 of 10

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const mode = option("--mode", "direct");
const apiUrl = option("--api", "http://127.0.0.1:3000");
if (mode !== "direct" && mode !== "http") throw new Error("--mode must be direct or http");

const storiesDir = process.env.STORIES_DIR;
if (!storiesDir) throw new Error("STORIES_DIR is not set in .env");

// Questions live with the private stories, outside the repo.
type Question = { id: string; question: string; expected_story_id: string };
const { questions } = JSON.parse(fs.readFileSync(path.join(storiesDir, "questions.json"), "utf8")) as {
  questions: Question[];
};

type Hit = { story_id: string; score: number };

// Story ids may be written "A1" or "story-a1"; compare them the same way.
const norm = (id: string) => id.toLowerCase().replace(/^story-/, "");

// --- direct mode: embed (with a disk cache), then search by vector ---------------------------------

// The cache is keyed by sha256(model + question), so it holds vectors only, no question text,
// and changing the model or editing a question automatically misses. It sits outside the repo, in a hidden
// folder so generated files never get mixed up with the user's own files in STORIES_DIR.
const cacheDir = path.join(storiesDir, ".story-search");
const cachePath = path.join(cacheDir, "eval-embeddings.json");
const cacheKey = (q: string) => createHash("sha256").update(`${EMBEDDING_MODEL}:${q}`).digest("hex");

async function embedQuestions(qs: Question[]): Promise<{ vectors: Map<string, number[]>; note: string }> {
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
  const vectors = new Map(qs.map((q) => [q.id, cache[cacheKey(q.question)]]));
  return { vectors, note: `cache: ${qs.length - missing.length}/${qs.length} hits, embedded ${missing.length}` };
}

// --- http mode: ask the running server ---------------------------------------------------------------

async function searchHttp(question: string): Promise<Hit[]> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/search?q=${encodeURIComponent(question)}&k=${TOP_K}`);
  } catch {
    throw new Error(`Could not reach ${apiUrl}. Is the server running? Start it with: npm run api`);
  }
  if (!res.ok) throw new Error(`/search returned ${res.status}`);
  return ((await res.json()) as { results: Hit[] }).results;
}

// --- run ---------------------------------------------------------------------------------------------

try {
  let vectors = new Map<string, number[]>();
  let note = "embedded server-side, no cache";
  if (mode === "direct") ({ vectors, note } = await embedQuestions(questions));

  console.log(`Eval: ${questions.length} questions, mode=${mode}, top ${TOP_K} (${note})`);
  if (mode === "direct") console.log(`Cache file: ${cachePath}`);
  console.log();

  let inTop = 0;
  let first = 0;
  for (const q of questions) {
    const hits = mode === "direct" ? await searchByVector(vectors.get(q.id)!, TOP_K) : await searchHttp(q.question);
    const rank = hits.findIndex((h) => norm(h.story_id) === norm(q.expected_story_id)) + 1; // 0 = not found
    if (rank > 0) inTop++;
    if (rank === 1) first++;

    // Only ids, ranks and scores are printed, never question or story text.
    const top = hits.map((h) => `${h.story_id}(${h.score.toFixed(2)})`).join(" ");
    console.log(
      `${q.id.padEnd(5)} expected ${q.expected_story_id.padEnd(4)} got ${top.padEnd(36)} ${rank ? `rank ${rank}` : "miss  "}  ${rank ? "PASS" : "FAIL"}`,
    );
  }

  console.log(`\n${inTop}/${questions.length} expected story in top ${TOP_K} (target >= ${TARGET}); ${first} ranked first`);
  if (inTop < TARGET) process.exitCode = 1;
} finally {
  await milvus.closeConnection();
}
