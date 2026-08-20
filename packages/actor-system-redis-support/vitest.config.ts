import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@yingyeothon/actor-system-redis-support",
    globalSetup: "./test/global-setup.ts",
    // All test files share a single Redis container and flush it between
    // tests, so they must not run concurrently.
    fileParallelism: false,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
