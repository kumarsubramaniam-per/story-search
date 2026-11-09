import os from "node:os";
import path from "node:path";
import { beforeEach, vi } from "vitest";

// env.ts loads the real .env, which CI and fresh clones don't have (and tests must never read real keys).
vi.mock("../packages/api/src/env.ts", () => ({}));

// Safety net: any code that reaches the activity logger writes to a throwaway file, never to logs/activity.log.
process.env.LOG_FILE = path.join(os.tmpdir(), `story-search-test-${process.pid}.log`);

// Every test starts from a clean configuration, whatever the developer's shell has exported and whatever an
// earlier test set.
const CONFIG = ["MIN_SCORE", "SEARCH_MODE", "ELASTICSEARCH_URL", "ELASTICSEARCH_ANALYZER", "CHAT_MODEL", "OPENAI_API_KEY"];
beforeEach(() => {
  for (const name of CONFIG) delete process.env[name];
});
