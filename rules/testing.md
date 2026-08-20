# Testing

## Non-negotiable

- No task is complete without tests covering the new or changed behavior.
- Keep core logic free of IO and ambient state so it is unit-testable without
  Docker, AWS, or a live socket. If a change is hard to test, the seam is wrong
  — fix the seam (see [architecture.md](architecture.md)), do not skip the test.

## Layout & running

- Tests live in `packages/<name>/test/*.test.ts` and import the package's public
  surface, not internal file paths.
- `pnpm test` runs vitest across all packages via `projects: ["packages/*"]`.
  Run a single package with `pnpm vitest run packages/<name>`.
- Coverage thresholds are enforced **per package** (`lines/functions/statements`
  80, `branches` 70) so no package hides behind the monorepo aggregate. Adding a
  package means adding enough tests to clear its own bar.

## Doubles

- AWS SDK v3 → `aws-sdk-client-mock`. Never hit real AWS.
- HTTP → `undici` `MockAgent`. Never hit a real network.
- Time → `vi.useFakeTimers()`; assert scheduling explicitly instead of sleeping.
- Environment → `vi.stubEnv`, and only when testing an `*OptionsFromEnv()` helper.
  Everything else takes injected options.
- Logging assertions use a capturing `LogWriter`, never spies on `console`.

## Redis integration tests

- `naive-redis`, `repository-redis`, and `actor-system-redis` use
  `@testcontainers/redis` via `test/global-setup.ts`, which provides
  `redisHost`/`redisPort` through vitest's `ProvidedContext`.
- Those packages pin `fileParallelism: false` + `pool: "forks"` +
  `singleFork: true` because all test files share one container and flush it
  between tests. Do not remove those settings or add concurrent tests there.
- Timeouts are already raised (`testTimeout` 60s, `hookTimeout` 120s) for
  container startup. Docker must be running locally.
- The package's `tsconfig.json` `include` must list `vitest.config.ts`, or
  type-aware lint fails on it.

## Assertions

- Assert observable behavior of the public API, not internal call counts.
- Cover the failure paths: timeouts, reconnects, auth errors, malformed
  protocol frames, and expiry — these are where past bugs actually lived.
