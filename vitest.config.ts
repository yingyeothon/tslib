import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The `!**/*.md` is load-bearing: `examples/*` matches files as well as
    // directories, and vitest tries to load `examples/README.md` as a project
    // config, failing with "No loader is configured for .md files".
    projects: ["packages/*", "examples/*", "!**/*.md"],
    coverage: {
      provider: "v8",
      // Examples import each package's built `dist`, which is outside this
      // glob, so an example smoke test can neither raise nor lower a
      // threshold below. Never add example code here.
      include: ["packages/*/src/**"],
      thresholds: {
        // Enforced per package so one package cannot hide behind the
        // monorepo aggregate.
        "packages/*/src/**": {
          lines: 80,
          functions: 80,
          statements: 80,
          branches: 70,
        },
      },
    },
  },
});
