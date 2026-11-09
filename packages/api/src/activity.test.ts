import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addToRequest,
  createLogger,
  logFilePath,
  logRequest,
  newRequestStore,
  runInRequest,
  timed,
} from "./activity.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "story-activity-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const readLines = (file: string) =>
  fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

describe("logFilePath", () => {
  it("uses LOG_FILE when set and falls back to logs/activity.log in the repo", () => {
    const saved = process.env.LOG_FILE;
    process.env.LOG_FILE = "  /somewhere/else.log ";
    expect(logFilePath()).toBe("/somewhere/else.log");
    delete process.env.LOG_FILE;
    expect(logFilePath().endsWith(path.join("logs", "activity.log"))).toBe(true);
    process.env.LOG_FILE = saved;
  });
});

describe("createLogger", () => {
  it("appends one JSON object per line with a timestamp and the event name, creating folders", () => {
    const file = path.join(dir, "nested", "a.log");
    const log = createLogger(file);
    log("one", { n: 1 });
    log("two", { n: 2 });
    const [a, b] = readLines(file);
    expect(a).toMatchObject({ event: "one", n: 1 });
    expect(b).toMatchObject({ event: "two", n: 2 });
    expect(new Date(a.ts).toISOString()).toBe(a.ts);
  });

  it("rotates to <file>.1 once the size limit is reached, replacing an older rotation", () => {
    const file = path.join(dir, "a.log");
    const log = createLogger(file, 50);
    log("first", { pad: "x".repeat(60) });
    log("second", {});
    expect(readLines(`${file}.1`)[0].event).toBe("first");
    expect(readLines(file).map((l) => l.event)).toEqual(["second"]);
    log("third", { pad: "x".repeat(60) });
    log("fourth", {});
    expect(readLines(`${file}.1`)[0].event).toBe("third");
  });

  it("warns once and never throws when the file cannot be written", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "a file, not a folder");
    const log = createLogger(path.join(blocker, "a.log"));
    expect(() => {
      log("x", {});
      log("y", {});
    }).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("timed", () => {
  it("just runs the function outside a request", async () => {
    expect(timed("chat", () => 5)).toBe(5);
    await expect(timed("chat", async () => "ok")).resolves.toBe("ok");
  });

  it("adds the duration of sync and async work to the request's stage, accumulating repeats", async () => {
    const store = newRequestStore("r1");
    await runInRequest(store, async () => {
      timed("vector", () => 1);
      await timed("vector", () => new Promise((r) => setTimeout(r, 15)));
      await timed("chat", async () => 1);
    });
    expect(store.stages.vector).toBeGreaterThanOrEqual(10);
    expect(store.stages.chat).toBeGreaterThanOrEqual(0);
    expect(Object.keys(store.stages).sort()).toEqual(["chat", "vector"]);
  });

  it("still records the stage, and rethrows, when the work fails (sync or async)", async () => {
    const store = newRequestStore("r2");
    await runInRequest(store, async () => {
      expect(() =>
        timed("embed", () => {
          throw new Error("boom");
        }),
      ).toThrow("boom");
      await expect(timed("chat", () => Promise.reject(new Error("later")))).rejects.toThrow("later");
    });
    expect(store.stages).toHaveProperty("embed");
    expect(store.stages).toHaveProperty("chat");
  });
});

describe("addToRequest", () => {
  it("sums into a numeric field of the current request and is a no-op outside one", () => {
    addToRequest("embedding_tokens", 5); // outside a request: nothing happens, nothing throws
    const store = newRequestStore("r3");
    runInRequest(store, () => {
      addToRequest("embedding_tokens", 5);
      addToRequest("embedding_tokens", 7);
    });
    expect(store.fields.embedding_tokens).toBe(12);
  });
});

describe("logRequest", () => {
  const lastRecord = () => readLines(process.env.LOG_FILE!).at(-1);

  it("writes id, route pattern, status, timings and the handler's fields", () => {
    const store = newRequestStore("req-1");
    store.stages.vector = 3.2;
    Object.assign(store.fields, { mode: "vector", k: 3, query_chars: 12, results: 2 });
    logRequest(store, "/search", 200);
    expect(lastRecord()).toMatchObject({
      event: "request",
      id: "req-1",
      route: "/search",
      status: 200,
      stages: { vector: 3.2 },
      mode: "vector",
      query_chars: 12,
      results: 2,
    });
    expect(typeof lastRecord().ms).toBe("number");
    expect(lastRecord().error).toBeUndefined();
  });

  it("scrubs the query text out of error messages and truncates long ones", () => {
    const store = newRequestStore("req-2");
    store.secrets.push("a private sample query");
    store.error = new Error(`failed on "a private sample query" twice: a private sample query ${"z".repeat(300)}`);
    logRequest(store, "/ask", 500);
    const raw = fs.readFileSync(process.env.LOG_FILE!, "utf8");
    expect(raw).not.toContain("a private sample query");
    const { error } = lastRecord();
    expect(error.name).toBe("Error");
    expect(error.message).toContain("[text]");
    expect(error.message.length).toBeLessThanOrEqual(200);
  });

  it("ignores empty secrets instead of mangling the message", () => {
    const store = newRequestStore("req-3");
    store.secrets.push("");
    store.error = new Error("plain failure");
    logRequest(store, "/ask", 500);
    expect(lastRecord().error.message).toBe("plain failure");
  });
});
