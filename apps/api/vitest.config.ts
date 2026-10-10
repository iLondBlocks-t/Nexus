import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
