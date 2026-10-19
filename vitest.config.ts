import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "test/**/*.test.ts"],
    exclude: ["test/live/**", "node_modules/**"],
    environment: "node",
    testTimeout: 20_000,
    globalSetup: ["test/global-setup.ts"],
  },
});
