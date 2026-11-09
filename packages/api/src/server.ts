import "./env.js";
import { getMinScore } from "./searchMilvus.js";
import { availableModes, defaultMode } from "./search.js";
import { logEvent } from "./activity.js";
import { buildApp } from "./app.js";

const app = buildApp();

// Local only: bind to loopback so nothing else on the network can reach it.
await app.listen({ host: "127.0.0.1", port: 3000 });
logEvent("server_start", {
  modes: availableModes(),
  defaultMode: defaultMode(),
  minScore: getMinScore(),
  chatModel: process.env.CHAT_MODEL ?? null,
});

// Close on Ctrl-C or a kill, so the connections shut down cleanly and the stop is logged.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}
