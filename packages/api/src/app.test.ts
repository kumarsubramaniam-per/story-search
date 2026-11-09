import fs from "node:fs";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { SearchHit } from "./searchMilvus.js";

const m = vi.hoisted(() => ({
  search: vi.fn(),
  askQuestion: vi.fn(),
  closeConnection: vi.fn(),
  closeEs: vi.fn(),
}));
vi.mock("./search.js", async () => {
  const real = await vi.importActual<typeof import("./search.js")>("./search.js");
  return { ...real, search: m.search };
});
vi.mock("./embed.js", () => ({ embedTexts: vi.fn() })); // keeps the real OpenAI client out of the import graph
vi.mock("./rag.js", () => ({ askQuestion: m.askQuestion }));
vi.mock("./milvus.js", () => ({ milvus: { closeConnection: m.closeConnection } }));
vi.mock("./searchEs.js", () => ({
  closeEs: m.closeEs,
  getEsUrl: () => process.env.ELASTICSEARCH_URL?.trim() || null,
}));

const { buildApp } = await import("./app.js");
const { RequestError } = await import("./search.js");

const hit = (id: string): SearchHit => ({
  chunk_id: `c-${id}`,
  story_id: id,
  title: `T ${id}`,
  snippet: `snippet ${id}`,
  text: `FULL TEXT ${id}`,
  score: 0.5,
});

const askResult = (over: object = {}) => ({
  answer: "Sample answer [a].",
  model: "sample-model",
  found: true,
  truncated: false,
  cited: ["a"],
  invalidCitations: [],
  sources: [{ chunk_id: "c-a", story_id: "a", title: "T a", score: 0.5 }],
  usage: { prompt_tokens: 120, completion_tokens: 30 },
  mode: "vector",
  noMatches: false,
  ...over,
});

const logRecords = () => {
  const file = process.env.LOG_FILE!;
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
};
const lastRequest = () => logRecords().filter((r) => r.event === "request").at(-1);

let app: ReturnType<typeof buildApp>;
beforeEach(async () => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.closeConnection.mockResolvedValue(undefined);
  m.closeEs.mockResolvedValue(undefined);
  fs.rmSync(process.env.LOG_FILE!, { force: true });
  app = buildApp({ logger: false });
  await app.ready();
});
afterEach(() => app.close());

describe("buildApp startup checks", () => {
  it("refuses to start when SEARCH_MODE names a mode that needs Elasticsearch which is not configured", () => {
    process.env.SEARCH_MODE = "hybrid";
    expect(() => buildApp({ logger: false })).toThrow(/ELASTICSEARCH_URL/);
  });

  it("refuses to start on an unknown SEARCH_MODE", () => {
    process.env.SEARCH_MODE = "fuzzy";
    expect(() => buildApp({ logger: false })).toThrow(/SEARCH_MODE/);
  });
});

describe("GET /health", () => {
  it("reports which modes this setup can serve", async () => {
    const res = await app.inject("/health");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, modes: { vector: true, keyword: false, hybrid: false }, defaultMode: "vector" });
  });
});

describe("GET /", () => {
  it("serves the web page as HTML", async () => {
    const res = await app.inject("/");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });
});

describe("GET /search", () => {
  it("returns hits without their full text, using the default k and mode", async () => {
    m.search.mockResolvedValue([hit("a"), hit("b")]);
    const res = await app.inject("/search?q=sample%20query");
    expect(res.statusCode).toBe(200);
    expect(m.search).toHaveBeenCalledWith("sample query", 3, "vector");
    const body = res.json();
    expect(body).toMatchObject({ query: "sample query", k: 3, mode: "vector", minScore: null });
    expect(body.results.map((r: SearchHit) => r.story_id)).toEqual(["a", "b"]);
    expect(JSON.stringify(body)).not.toContain("FULL TEXT");
  });

  it("passes k and mode through, and reports a null minScore for keyword mode", async () => {
    process.env.MIN_SCORE = "0.2";
    process.env.ELASTICSEARCH_URL = "http://localhost:9200";
    const es = buildApp({ logger: false });
    m.search.mockResolvedValue([]);
    const kw = (await es.inject("/search?q=x&k=5&mode=keyword")).json();
    expect(m.search).toHaveBeenCalledWith("x", 5, "keyword");
    expect(kw.minScore).toBeNull();
    const vec = (await es.inject("/search?q=x&mode=hybrid")).json();
    expect(vec.minScore).toBe(0.2);
    await es.close();
  });

  it("rejects a missing, blank, over-long or badly-typed request with 400, without searching", async () => {
    for (const url of ["/search", "/search?q=", "/search?q=%20%20", `/search?q=${"a".repeat(501)}`, "/search?q=x&k=0", "/search?q=x&k=11", "/search?q=x&k=abc", "/search?q=x&mode=fuzzy"]) {
      expect((await app.inject(url)).statusCode, url).toBe(400);
    }
    expect(m.search).not.toHaveBeenCalled();
  });

  it("answers a RequestError with its own status code", async () => {
    m.search.mockRejectedValue(new RequestError("needs elasticsearch", 400));
    const res = await app.inject("/search?q=x");
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("needs elasticsearch");
  });

  it("answers an unexpected failure with 500", async () => {
    m.search.mockRejectedValue(new Error("milvus down"));
    expect((await app.inject("/search?q=x")).statusCode).toBe(500);
  });
});

describe("POST /ask", () => {
  it("returns the answer with minScore and passes question, k and mode to the RAG step", async () => {
    m.askQuestion.mockResolvedValue(askResult());
    const res = await app.inject({ method: "POST", url: "/ask", payload: { question: "What is sample?", k: 2 } });
    expect(res.statusCode).toBe(200);
    expect(m.askQuestion).toHaveBeenCalledWith("What is sample?", 2, undefined, "vector");
    expect(res.json()).toMatchObject({ answer: "Sample answer [a].", cited: ["a"], minScore: null });
  });

  it("rejects bad bodies with 400, without calling the chat step", async () => {
    for (const payload of [{}, { question: "" }, { question: "   " }, { question: "x", k: 99 }, { question: "x", mode: "fuzzy" }, { question: "a".repeat(501) }]) {
      expect((await app.inject({ method: "POST", url: "/ask", payload })).statusCode, JSON.stringify(payload).slice(0, 40)).toBe(400);
    }
    expect(m.askQuestion).not.toHaveBeenCalled();
  });

  it("answers a failure in the RAG step with 500", async () => {
    m.askQuestion.mockRejectedValue(new Error("chat down"));
    expect((await app.inject({ method: "POST", url: "/ask", payload: { question: "x" } })).statusCode).toBe(500);
  });
});

describe("activity log (spec §8): lengths, counts and timings only", () => {
  it("logs a /search request without the query text, using the route pattern", async () => {
    m.search.mockResolvedValue([hit("a")]);
    await app.inject("/search?q=a-very-private-sample-query&k=2");
    const rec = lastRequest();
    expect(rec).toMatchObject({ route: "/search", status: 200, mode: "vector", k: 2, query_chars: 27, results: 1 });
    const raw = fs.readFileSync(process.env.LOG_FILE!, "utf8");
    expect(raw).not.toContain("a-very-private-sample-query");
    expect(raw).not.toContain("snippet a");
    expect(raw).not.toContain("FULL TEXT");
  });

  it("logs an /ask request with token counts and no question or answer text", async () => {
    m.askQuestion.mockResolvedValue(askResult({ invalidCitations: ["zz"], truncated: true }));
    await app.inject({ method: "POST", url: "/ask", payload: { question: "a-very-private-sample-question" } });
    expect(lastRequest()).toMatchObject({
      route: "/ask",
      status: 200,
      question_chars: 30,
      results: 1,
      no_matches: false,
      found: true,
      truncated: true,
      cited: 1,
      invalid_citations: 1,
      model: "sample-model",
      prompt_tokens: 120,
      completion_tokens: 30,
    });
    const raw = fs.readFileSync(process.env.LOG_FILE!, "utf8");
    expect(raw).not.toContain("a-very-private-sample-question");
    expect(raw).not.toContain("Sample answer");
  });

  it("logs model as null when the chat call was skipped", async () => {
    m.askQuestion.mockResolvedValue(askResult({ model: "", noMatches: true, found: false, sources: [] }));
    await app.inject({ method: "POST", url: "/ask", payload: { question: "x" } });
    expect(lastRequest()).toMatchObject({ model: null, no_matches: true, results: 0 });
  });

  it("scrubs the query out of the error message of a failed request", async () => {
    m.search.mockRejectedValue(new Error("no results for a-very-private-sample-query at all"));
    await app.inject("/search?q=a-very-private-sample-query");
    const rec = lastRequest();
    expect(rec.status).toBe(500);
    expect(rec.error.message).toBe("no results for [text] at all");
    expect(fs.readFileSync(process.env.LOG_FILE!, "utf8")).not.toContain("a-very-private-sample-query");
  });

  it("logs validation failures and unknown routes, without the URL", async () => {
    await app.inject("/search?q=");
    expect(lastRequest()).toMatchObject({ route: "/search", status: 400 });
    await app.inject("/no/such/secret-path");
    expect(lastRequest()).toMatchObject({ route: "(unmatched)", status: 404 });
    expect(fs.readFileSync(process.env.LOG_FILE!, "utf8")).not.toContain("secret-path");
  });
});

describe("shutdown", () => {
  it("logs the stop and closes the Milvus and Elasticsearch connections", async () => {
    await app.close();
    expect(logRecords().some((r) => r.event === "server_stop")).toBe(true);
    expect(m.closeConnection).toHaveBeenCalledOnce();
    expect(m.closeEs).toHaveBeenCalledOnce();
  });
});
