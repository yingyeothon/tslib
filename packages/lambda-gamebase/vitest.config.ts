import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@yingyeothon/lambda-gamebase",
    globalSetup: "./test/global-setup.ts",
    // The pub/sub transport test shares one Redis container with the rest
    // of the suite, so the files must not run concurrently.
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
