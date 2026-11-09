import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());
vi.mock("openai", () => ({
  default: class {
    embeddings = { create };
  },
}));

const { embedTexts, totalEmbeddingTokens, EMBEDDING_MODEL, EMBEDDING_DIMS } = await import("./embed.js");
const { newRequestStore, runInRequest } = await import("./activity.js");

const reply = (tokens: number, vectors: number[][]) => ({
  usage: { total_tokens: tokens },
  data: vectors.map((embedding, index) => ({ index, embedding })),
});

beforeEach(() => {
  create.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("embedTexts", () => {
  it("sends one request with the project's model and dimensions", async () => {
    create.mockResolvedValue(reply(4, [[1], [2]]));
    await embedTexts(["first sample", "second sample"]);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({ model: EMBEDDING_MODEL, input: ["first sample", "second sample"], dimensions: EMBEDDING_DIMS });
  });

  it("returns vectors in input order even if the API answers out of order", async () => {
    create.mockResolvedValue({ usage: { total_tokens: 3 }, data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] });
    expect(await embedTexts(["a", "b"])).toEqual([[1], [2]]);
  });

  it("adds the billed tokens to the process total and to the current request", async () => {
    const before = totalEmbeddingTokens();
    create.mockResolvedValue(reply(9, [[1]]));
    const store = newRequestStore("r");
    await runInRequest(store, () => embedTexts(["sample"]));
    expect(totalEmbeddingTokens()).toBe(before + 9);
    expect(store.fields.embedding_tokens).toBe(9);
    expect(store.stages).toHaveProperty("embed");
  });

  it("rejects an input over the model limit before calling the API", async () => {
    await expect(embedTexts(["ok", "word ".repeat(9000)])).rejects.toThrow(/Input 1 has \d+ tokens/);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a batch over the per-request ceiling before calling the API", async () => {
    const big = "word ".repeat(7000); // under the per-input limit, but 15 of them are over the batch ceiling
    await expect(embedTexts(Array(15).fill(big))).rejects.toThrow(/Batch has \d+ tokens/);
    expect(create).not.toHaveBeenCalled();
  });

  it("propagates an API failure without retrying", async () => {
    create.mockRejectedValue(new Error("api down"));
    await expect(embedTexts(["sample"])).rejects.toThrow("api down");
    expect(create).toHaveBeenCalledOnce();
  });
});
