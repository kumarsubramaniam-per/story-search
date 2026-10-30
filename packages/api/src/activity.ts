import "./env.js";
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";

// Activity log (spec §8): one JSON object per line, appended to logs/activity.log (git-ignored).
// It records what the app does (which route, mode, how long each stage took, how many tokens) and never what
// it was asked: no query text, story text, snippets or answers, only lengths, counts, ids and numbers.

export const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** LOG_FILE from .env (an absolute path), or logs/activity.log at the repo root. */
export function logFilePath(): string {
  return process.env.LOG_FILE?.trim() || fileURLToPath(new URL("../../../logs/activity.log", import.meta.url));
}

/**
 * Returns a function that appends one event to `file`. When the file reaches `maxBytes` it is renamed to
 * `<file>.1` (replacing an older one), so the log never grows past about twice that size. A failure to write
 * is reported once and never breaks a request.
 */
export function createLogger(file: string, maxBytes = MAX_LOG_BYTES) {
  let warned = false;
  return (event: string, fields: Record<string, unknown>): void => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size >= maxBytes) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + "\n");
    } catch (err) {
      if (!warned) {
        warned = true;
        console.warn(`Activity log: cannot write ${file}: ${(err as Error).message}`);
      }
    }
  };
}

let write: ReturnType<typeof createLogger> | undefined;
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  write ??= createLogger(logFilePath());
  write(event, fields);
}

// What one request collects while it runs. AsyncLocalStorage carries it through every await, so the search,
// embedding and chat code can record their timings without the request being passed down as an argument.
export type RequestStore = {
  id: string;
  start: number;
  stages: Record<string, number>; // milliseconds per stage: embed, vector, keyword, fuse, chat
  fields: Record<string, unknown>; // counts and numbers worth logging, set by the route handler
  secrets: string[]; // text that must never appear in the log, such as the query; scrubbed from error messages
  error?: Error;
};

const requestContext = new AsyncLocalStorage<RequestStore>();

export function newRequestStore(id: string): RequestStore {
  return { id, start: performance.now(), stages: {}, fields: {}, secrets: [] };
}

export function runInRequest<T>(store: RequestStore, fn: () => T): T {
  return requestContext.run(store, fn);
}

const round = (ms: number) => Math.round(ms * 10) / 10;

/** Runs `fn` and adds its duration to the current request's `stage`. Outside a request (ingest, eval) it just runs `fn`. */
export function timed<T>(stage: string, fn: () => T): T {
  const store = requestContext.getStore();
  if (!store) return fn();
  const start = performance.now();
  const done = () => {
    store.stages[stage] = round((store.stages[stage] ?? 0) + performance.now() - start);
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(done) as T;
    done();
    return result;
  } catch (err) {
    done();
    throw err;
  }
}

/** Adds `n` to a numeric field of the current request (for example embedding tokens). No-op outside a request. */
export function addToRequest(field: string, n: number): void {
  const store = requestContext.getStore();
  if (store) store.fields[field] = ((store.fields[field] as number | undefined) ?? 0) + n;
}

/** Writes the one line that describes a finished request. */
export function logRequest(store: RequestStore, route: string, status: number): void {
  const record: Record<string, unknown> = {
    id: store.id,
    route,
    status,
    ms: round(performance.now() - store.start),
    stages: store.stages,
    ...store.fields,
  };
  if (store.error) {
    let message = store.error.message;
    for (const secret of store.secrets) if (secret) message = message.split(secret).join("[text]");
    record.error = { name: store.error.name, message: message.slice(0, 200) };
  }
  logEvent("request", record);
}
