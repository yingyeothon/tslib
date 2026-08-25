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

- `naive-redis`, `repository-redis`, `actor-system-redis`, and
  `lambda-gamebase` use `@testcontainers/redis` via `test/global-setup.ts`,
  which provides `redisHost`/`redisPort` through vitest's `ProvidedContext`.
  `lambda-gamebase` needs it only for the Redis pub/sub transport, but a
  `globalSetup` is per project, so its whole suite runs against a container.
- Those packages pin `fileParallelism: false` + `pool: "forks"` +
  `singleFork: true` because all test files share one container and flush it
  between tests. Do not remove those settings or add concurrent tests there.
- Timeouts are already raised (`testTimeout` 60s, `hookTimeout` 120s) for
  container startup. Docker must be running locally.
- The package's `tsconfig.json` `include` must list `vitest.config.ts`, or
  type-aware lint fails on it.

## Prefer an injected seam to a module mock

- `vi.mock` on a whole workspace package hides the seam and asserts call
  counts instead of behavior. Injecting a fake (`NetworkOptions.transport`,
  an in-memory queue, a capturing `Logger`) tests what the code actually
  sent.
- It also changes what is observable, so re-check assertions when switching:
  a mocked `broadcast` records a call even with zero connections, while a
  real transport sends nothing — assert through a hook when nobody is
  connected.

## Asserting that something was NOT logged

- A "never logs the secret" test needs a **positive control**. `expect(text)
.not.toContain(secret)` passes just as well when nothing was logged at all,
  so assert some expected line is present in the same breath.
- Do not build the haystack with `JSON.stringify`: it renders an `Error` as
  `{}`, and the uncontrolled log call is almost always `logger.error(error)`.
  Flatten errors to `name + message + stack` in the capturing writer.
- Assert against a fixture whose values cannot collide with unrelated log text
  (`"NAME-ALPHA-9f2"`, not `"one"`), and assert each token _segment_ as well as
  the whole token — a leak often prints only part of it.

## Ordering is the behavior, so assert the order

- For lock ownership, hand-off, and lifecycle, a count proves nothing — the bug
  is always a sequence. Wrap the double in a recorder that appends one event
  per call (`acquire`, `message:1`, `release`, `shift`) and assert the whole
  array. That is what pins "released before shifting" and "not released between
  drain cycles", which `toHaveBeenCalledTimes` cannot express.
- Reach the interleaving with a real one. Two lock instances sharing a key,
  with a short `lockTimeout` and a real sleep, is how "a stalled holder does not
  delete its successor's lock" gets tested; a mock cannot produce that state.

## A test that cannot fail is not coverage

- Before adding a test, ask what implementation it rejects. "A queue with no
  TTL still exists after a second" passes under every implementation; the
  same pair of keys, one option apart, rejects both "always expires" and
  "never expires".
- Deduplicating the assertion deletes the behavior. `[...new Set(dropped)]`
  cannot tell one drop from three.
- When ordering is the point, assert the interleaving. "Every end frame
  precedes every drop" is what separates announce-then-drop from a repeated
  announce/drop pair; counting each in isolation does not.

## Assertions

- Assert observable behavior of the public API, not internal call counts.
- Cover the failure paths: timeouts, reconnects, auth errors, malformed
  protocol frames, and expiry — these are where past bugs actually lived.
- A test that mocks the thing under test into an unreachable state proves
  nothing. Mocking `jwt.verify` to return a string exercised a branch no real
  token can reach, while the shapes that _do_ get through (a JSON array
  payload, a `complete: true` envelope) stayed untested. Reach the state with
  a real input, or the branch is not covered.
- Type-level guards are not runtime guards. `Omit<T, "k">` only rejects an
  object _literal_; a variable or a spread carries the key straight through.
  Test the runtime override, not the type.
