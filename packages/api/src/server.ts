import "./env.js";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { searchStories, getMinScore } from "./searchMilvus.js";
import { askQuestion } from "./rag.js";
import { milvus } from "./milvus.js";

const DEFAULT_K = 3;

// Request logging is off: the URL would put the user's query text in the logs. Embedding usage is logged in embed.ts.
const app = Fastify({ logger: true, disableRequestLogging: true });

app.get("/health", async () => ({ ok: true }));

// The web page (packages/web/index.html) is served from the same origin as the API, so no CORS is needed.
// It is read on each request, so edits show up on refresh without restarting the server.
const indexPath = fileURLToPath(new URL("../../web/index.html", import.meta.url));
app.get("/", async (_req, reply) => reply.type("text/html; charset=utf-8").send(fs.readFileSync(indexPath, "utf8")));

// GET /search?q=...&k=3  ->  ranked stories with scores
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
        },
      },
    },
  },
  async (req, reply) => {
    const { q, k } = req.query as { q: string; k: number };
    if (!q.trim()) return reply.code(400).send({ error: "q must not be blank" });
    // The full story text stays server-side; the page only needs a snippet.
    const results = (await searchStories(q, k)).map(({ text, ...hit }) => hit);
    return { query: q, k, minScore: getMinScore(), results };
  },
);

// POST /ask {question, k}  ->  answer grounded in the top-k stories, with the stories it cited
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
        },
      },
    },
  },
  async (req, reply) => {
    const { question, k } = req.body as { question: string; k: number };
    if (!question.trim()) return reply.code(400).send({ error: "question must not be blank" });
    return { ...(await askQuestion(question, k)), minScore: getMinScore() };
  },
);

app.addHook("onClose", async () => {
  await milvus.closeConnection();
});

// Local only: bind to loopback so nothing else on the network can reach it.
await app.listen({ host: "127.0.0.1", port: 3000 });
