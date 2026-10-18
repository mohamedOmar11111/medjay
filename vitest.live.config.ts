import { defineConfig } from "vitest/config";

// Live tests call real models (Gemini, local Ollama). They cost money and are not deterministic,
// so they never run in `npm test`; use `npm run test:live`.
export default defineConfig({
  test: {
    include: ["test/live/**/*.live.test.ts"],
    environment: "node",
    testTimeout: 600_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
