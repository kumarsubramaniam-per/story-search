import "./env.js";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyRequest } from "fastify";
import { getMinScore } from "./searchMilvus.js";
import { search, availableModes, defaultMode, SEARCH_MODES, type SearchMode } from "./search.js";
import { closeEs } from "./searchEs.js";
import { askQuestion } from "./rag.js";
import { milvus } from "./milvus.js";
import { logEvent, logRequest, newRequestStore, runInRequest, type RequestStore } from "./activity.js";

const DEFAULT_K = 3;

// Fail at startup, not on the first request, if SEARCH_MODE is invalid or names a mode this setup can't serve.
const fallbackMode = defaultMode();
if (!availableModes()[fallbackMode]) {
  throw new Error(`SEARCH_MODE=${fallbackMode} is not available: keyword and hybrid need ELASTICSEARCH_URL.`);
}

// Request logging is off: the URL would put the user's query text in the logs. Embedding usage is logged in embed.ts.
const app = Fastify({ logger: true, disableRequestLogging: true });

// Activity log (spec §8): one line per request, written when the response is done. Route patterns are logged,
// never the URL, so the query text stays out. Handlers add counts to the request's store; see activity.ts.
const requests = new WeakMap<FastifyRequest, RequestStore>();
app.addHook("onRequest", async (req) => {
  requests.set(req, newRequestStore(req.id));
});
app.addHook("onError", async (req, _reply, err) => {
  const store = requests.get(req);
  if (store) store.error = err;
});
app.addHook("onResponse", async (req, reply) => {
  const store = requests.get(req);
  if (store) logRequest(store, req.routeOptions?.url ?? "(unmatched)", reply.statusCode);
});

// The page reads `modes` to disable the search methods that aren't set up.
app.get("/health", async () => ({ ok: true, modes: availableModes(), defaultMode: fallbackMode }));

// The web page (packages/web/index.html) is served from the same origin as the API, so no CORS is needed.
// It is read on each request, so edits show up on refresh without restarting the server.
const indexPath = fileURLToPath(new URL("../../web/index.html", import.meta.url));
app.get("/", async (_req, reply) => reply.type("text/html; charset=utf-8").send(fs.readFileSync(indexPath, "utf8")));

const modeSchema = { type: "string", enum: SEARCH_MODES };

// GET /search?q=...&k=3&mode=vector|keyword  ->  ranked stories with scores
app.get(
  "/search",
  {
    // Fastify validates (and converts k to a number) before the handler runs; failures become a 400.
    schema: {
      querystring: {
        type: "object",
        required: ["q"],
        properties: {
          q: { type: "string", minLength: 1, maxLength: 500 },
          k: { type: "integer", minimum: 1, maximum: 10, default: DEFAULT_K },
          mode: modeSchema,
        },
      },
    },
  },
  async (req, reply) => {
    const { q, k, mode = fallbackMode } = req.query as { q: string; k: number; mode?: SearchMode };
    if (!q.trim()) return reply.code(400).send({ error: "q must not be blank" });
    const store = requests.get(req)!;
    Object.assign(store.fields, { mode, k, query_chars: q.length });
    store.secrets.push(q);
    // The full story text stays server-side; the page only needs a snippet.
    const results = (await runInRequest(store, () => search(q, k, mode))).map(({ text, ...hit }) => hit);
    store.fields.results = results.length;
    // MIN_SCORE is a cosine threshold: it applies to vector results, including the vector side of hybrid.
    return { query: q, k, mode, minScore: mode === "keyword" ? null : getMinScore(), results };
  },
);

// POST /ask {question, k, mode}  ->  answer grounded in the top-k stories, with the stories it cited
app.post(
  "/ask",
  {
    schema: {
      body: {
        type: "object",
        required: ["question"],
        properties: {
          question: { type: "string", minLength: 1, maxLength: 500 },
          k: { type: "integer", minimum: 1, maximum: 10, default: DEFAULT_K },
          mode: modeSchema,
        },
      },
    },
  },
  async (req, reply) => {
    const { question, k, mode = fallbackMode } = req.body as { question: string; k: number; mode?: SearchMode };
    if (!question.trim()) return reply.code(400).send({ error: "question must not be blank" });
    const store = requests.get(req)!;
    Object.assign(store.fields, { mode, k, question_chars: question.length });
    store.secrets.push(question);
    const result = await runInRequest(store, () => askQuestion(question, k, undefined, mode));
    Object.assign(store.fields, {
      results: result.sources.length,
      no_matches: result.noMatches,
      found: result.found,
      truncated: result.truncated,
      cited: result.cited.length,
      invalid_citations: result.invalidCitations.length,
      model: result.model || null,
      prompt_tokens: result.usage.prompt_tokens,
      completion_tokens: result.usage.completion_tokens,
    });
    return { ...result, minScore: mode === "keyword" ? null : getMinScore() };
  },
);

app.addHook("onClose", async () => {
  logEvent("server_stop");
  await milvus.closeConnection();
  await closeEs();
});

// Local only: bind to loopback so nothing else on the network can reach it.
await app.listen({ host: "127.0.0.1", port: 3000 });
logEvent("server_start", {
  modes: availableModes(),
  defaultMode: fallbackMode,
  minScore: getMinScore(),
  chatModel: process.env.CHAT_MODEL ?? null,
});

// Close on Ctrl-C or a kill, so the connections shut down cleanly and the stop is logged.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}
