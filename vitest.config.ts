import { defineConfig } from "vitest/config";

// Unit tests live next to the code (*.test.ts). They are offline: no Docker, no API key, no .env needed.
export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    environment: "node",
  },
});
