import { fileURLToPath } from "node:url";

// npm workspace scripts run from inside each package folder, so the default
// lookup for .env would fail. Load the single root .env by explicit path:
// this file is packages/api/src/env.ts, so the repo root is three levels up.
const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));

// Built into Node 20.12+; sets process.env without printing anything.
process.loadEnvFile(envPath);
