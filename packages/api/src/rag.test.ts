import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchHit } from "./searchMilvus.js";

const chatCreate = vi.hoisted(() => vi.fn());
const searchMock = vi.hoisted(() => vi.fn());
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: chatCreate } };
  },
}));
vi.mock("./search.js", () => ({ search: searchMock, defaultMode: () => "vector" }));

const { askQuestion, parseCitations, NOT_FOUND } = await import("./rag.js");

const hit = (id: string, text = `Body of ${id}.`): SearchHit => ({
  chunk_id: `story-${id}`,
  story_id: id,
  title: `Title ${id}`,
  snippet: text,
  text,
  score: 0.5,
});

const chatReply = (content: string | null, extra: object = {}) => ({
  model: "sample-model-2026",
  usage: { prompt_tokens: 100, completion_tokens: 20 },
  choices: [{ message: { content }, finish_reason: "stop", ...extra }],
});

beforeEach(() => {
  chatCreate.mockReset();
  searchMock.mockReset();
  process.env.CHAT_MODEL = "gpt-5.4-mini";
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("parseCitations", () => {
  const ids = new Set(["alpha", "beta-2", "G 7"]);

  it("finds single and grouped citations and reports each id once", () => {
    const { cited, invalid } = parseCitations("Yes [alpha]. Also [alpha, beta-2] and [beta-2].", ids);
    expect(cited).toEqual(["alpha", "beta-2"]);
    expect(invalid).toEqual([]);
  });

  it("reports id-like tokens that were not retrieved as invalid", () => {
    const { cited, invalid } = parseCitations("See [alpha] and [ghost-9; alpha].", ids);
    expect(cited).toEqual(["alpha"]);
    expect(invalid).toEqual(["ghost-9"]);
  });

  it("accepts a retrieved id that contains a space", () => {
    expect(parseCitations("As noted [G 7].", ids).cited).toEqual(["G 7"]);
  });

  it("ignores bracketed prose instead of reporting its words as invalid citations", () => {
    expect(parseCitations("Note [see the sample] here.", ids)).toEqual({ cited: [], invalid: [] });
    expect(parseCitations("Note [see the sample, though!] here.", ids)).toEqual({ cited: [], invalid: [] });
  });

  it("ignores empty or punctuation-only groups, and answers with no brackets", () => {
    expect(parseCitations("Note [!!] and [, ;] here.", ids)).toEqual({ cited: [], invalid: [] });
    expect(parseCitations("No citations at all.", ids)).toEqual({ cited: [], invalid: [] });
  });

  it("keeps a retrieved id found inside a comma list that also holds prose", () => {
    const { cited, invalid } = parseCitations("See [alpha, see the sample].", ids);
    expect(cited).toEqual(["alpha"]);
    expect(invalid).toEqual([]);
  });

  it("only reads comma or semicolon lists: ids separated by spaces alone are not split", () => {
    expect(parseCitations("See [alpha beta-2].", ids)).toEqual({ cited: [], invalid: [] });
  });

  it("still reports a lone id-like token that was not retrieved", () => {
    expect(parseCitations("See [ghost-9].", ids)).toEqual({ cited: [], invalid: ["ghost-9"] });
  });
});

describe("askQuestion", () => {
  it("fails fast when CHAT_MODEL is not set, spending nothing", async () => {
    delete process.env.CHAT_MODEL;
    await expect(askQuestion("sample question", 3)).rejects.toThrow(/CHAT_MODEL/);
    expect(searchMock).not.toHaveBeenCalled();
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("skips the paid chat call when retrieval finds nothing", async () => {
    searchMock.mockResolvedValue([]);
    const r = await askQuestion("sample question", 3);
    expect(chatCreate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ answer: NOT_FOUND, found: false, noMatches: true, sources: [], model: "" });
    expect(r.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0 });
  });

  it("passes the question, k, mode and query vector on to retrieval", async () => {
    searchMock.mockResolvedValue([]);
    await askQuestion("sample question", 5, [0.1, 0.2], "hybrid");
    expect(searchMock).toHaveBeenCalledWith("sample question", 5, "hybrid", [0.1, 0.2]);
  });

  it("builds a grounded prompt with each story's id in brackets and caps the output", async () => {
    searchMock.mockResolvedValue([hit("alpha"), hit("beta")]);
    chatCreate.mockResolvedValue(chatReply("It is so [alpha]."));
    await askQuestion("What is so?", 2);
    const args = chatCreate.mock.calls[0][0];
    expect(args.max_completion_tokens).toBe(1000);
    expect(args.messages[0].role).toBe("system");
    expect(args.messages[1].content).toContain("[alpha] Title alpha\nBody of alpha.");
    expect(args.messages[1].content).toContain("[beta] Title beta");
    expect(args.messages[1].content).toContain("Question: What is so?");
  });

  it("turns reasoning off only for models that accept the parameter", async () => {
    searchMock.mockResolvedValue([hit("alpha")]);
    chatCreate.mockResolvedValue(chatReply("ok"));
    await askQuestion("q", 1);
    expect(chatCreate.mock.calls[0][0].reasoning_effort).toBe("none");

    process.env.CHAT_MODEL = "gpt-4.1-mini";
    await askQuestion("q", 1);
    expect(chatCreate.mock.calls[1][0]).not.toHaveProperty("reasoning_effort");
  });

  it("returns the answer with citations, sources, usage and the model the API reported", async () => {
    searchMock.mockResolvedValue([hit("alpha"), hit("beta")]);
    chatCreate.mockResolvedValue(chatReply("  Yes [alpha] and [ghost].  "));
    const r = await askQuestion("q", 2);
    expect(r).toMatchObject({
      answer: "Yes [alpha] and [ghost].",
      model: "sample-model-2026",
      found: true,
      truncated: false,
      cited: ["alpha"],
      invalidCitations: ["ghost"],
      noMatches: false,
      mode: "vector",
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    });
    expect(r.sources.map((s) => s.story_id)).toEqual(["alpha", "beta"]);
    expect(r.sources[0]).not.toHaveProperty("text"); // sources never carry the full story text
  });

  it("marks the not-found reply, whatever its case or trailing period", async () => {
    searchMock.mockResolvedValue([hit("alpha")]);
    for (const reply of [NOT_FOUND, "not found in the collection", "Not found in the collection."]) {
      chatCreate.mockResolvedValueOnce(chatReply(reply));
      expect((await askQuestion("q", 1)).found).toBe(false);
    }
    chatCreate.mockResolvedValueOnce(chatReply("The answer is X [alpha]."));
    expect((await askQuestion("q", 1)).found).toBe(true);
  });

  it("flags an answer cut off by the output cap", async () => {
    searchMock.mockResolvedValue([hit("alpha")]);
    chatCreate.mockResolvedValue(chatReply("Half an ans", { finish_reason: "length" }));
    expect((await askQuestion("q", 1)).truncated).toBe(true);
  });

  it("copes with an empty message body and a missing usage block", async () => {
    searchMock.mockResolvedValue([hit("alpha")]);
    chatCreate.mockResolvedValue({ model: "m", choices: [{ message: { content: null }, finish_reason: "stop" }] });
    const r = await askQuestion("q", 1);
    expect(r.answer).toBe("");
    expect(r.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0 });
  });

  it("rejects an oversized prompt before calling the chat API", async () => {
    searchMock.mockResolvedValue([hit("alpha", "word ".repeat(13_000))]);
    await expect(askQuestion("q", 1)).rejects.toThrow(/lower k/);
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("propagates a chat failure without retrying", async () => {
    searchMock.mockResolvedValue([hit("alpha")]);
    chatCreate.mockRejectedValue(new Error("chat down"));
    await expect(askQuestion("q", 1)).rejects.toThrow("chat down");
    expect(chatCreate).toHaveBeenCalledOnce();
  });
});
