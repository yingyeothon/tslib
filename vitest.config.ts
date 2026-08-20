import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*"],
    coverage: {
      provider: "v8",
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
