# Testing

## Non-negotiable

- No task is complete without tests covering the new or changed behavior.
- Keep core logic free of IO and ambient state so it is unit-testable without
  Docker, AWS, or a live socket. If a change is hard to test, the seam is wrong
  — fix the seam (see [architecture.md](architecture.md)), do not skip the test.

## Layout & running

- Tests live in `packages/<name>/test/*.test.ts` and import the package's public
  surface, not internal file paths.
- `pnpm test` runs vitest via
  `projects: ["packages/*", "examples/*", "!**/*.md"]`. The negation is
  load-bearing: those globs match files as well as directories, so without it
  vitest tries to load `examples/README.md` as a project config and dies with
  "No loader is configured for .md files".
  Run a single package with `pnpm vitest run packages/<name>`.
- **`examples/*` carry one smoke test each that runs the example and asserts
  its observable outcome.** That is what stops a documented snippet from
  rotting; typechecking alone does not prove a program runs. An example's
  Redis path is gated with `describe.skipIf(!process.env.REDIS_HOST)`, so
  `pnpm coverage` needs no Docker beyond what `packages/*` already needs.
- **An example can neither raise nor lower a coverage threshold.**
  `coverage.include` is `packages/*/src/**`, and an example's import resolves
  through the workspace symlink to `packages/*/dist/**`, so nothing it
  executes is a covered file. Never add example code to `coverage.include`.
- Coverage thresholds are enforced **per package** (`lines/functions/statements`
  80, `branches` 70) so no package hides behind the monorepo aggregate. Adding a
  package means adding enough tests to clear its own bar.

## Doubles

- AWS SDK v3 → `aws-sdk-client-mock`. Never hit real AWS.
- HTTP → `undici` `MockAgent`. Never hit a real network.
- WebSocket → a WHATWG-shaped fake class injected through the client's
  `WebSocket` option, driven from the test as the server
  (`packages/gamebase-client/test/fake-web-socket.ts`). Do not add `ws`; the
  SDK must never depend on it and a real socket cannot be told to close with
  code 4001 on cue.
- Time → `vi.useFakeTimers()`; assert scheduling explicitly instead of sleeping.
- Environment → `vi.stubEnv`, and only when testing an `*OptionsFromEnv()` helper.
  Everything else takes injected options.
- Logging assertions use a capturing `LogWriter`, never spies on `console`.

## Redis integration tests

- `naive-redis`, `repository-redis`, `actor-system-redis`, and
  `lambda-gamebase` use `@testcontainers/redis`, providing `redisHost`/
  `redisPort` through vitest's `ProvidedContext`. The container code lives
  once in `test-support/redis-global-setup.ts`; each package's
  `test/global-setup.ts` only re-exports it, and each `test/fixture.ts` wraps
  `withFlushedRedis` from `test-support/redis-fixture.ts` (FLUSHALL +
  disconnect in `finally`) with its own work signature. `lambda-gamebase`
  needs the container only for the Redis pub/sub transport, but a
  `globalSetup` is per project, so its whole suite runs against one.
- `test-support/` is not a workspace package: it has its own `tsconfig.json`
  for type-aware lint, cannot import `@yingyeothon/*` (helpers are typed
  structurally), and never import `redis-global-setup` from a fixture — that
  would load testcontainers in every test worker.
- Those packages pin `fileParallelism: false` + `pool: "forks"` +
  `singleFork: true` because all test files share one container and flush it
  between tests. Do not remove those settings or add concurrent tests there.
- Timeouts are already raised (`testTimeout` 60s, `hookTimeout` 120s) for
  container startup. Docker must be running locally.
- The package's `tsconfig.json` `include` must list `vitest.config.ts`, or
  type-aware lint fails on it.

## Writing an example that demonstrates something

- **Feed input at the point the real system would.** `examples/actor-game`'s
  first draft queued its attacks before the game started; the wait stage drains
  the queue for `enter`/`leave` and discards the rest, so the raid ended on
  `timeout` with nobody having hit anything and no error anywhere. An example
  that models the wrong timing teaches the wrong thing and still passes.
- **Make a race deterministic by holding one side open**, not by sleeping. Two
  real writers interleave differently every run, so the interesting order shows
  up rarely and cannot be asserted (`examples/repository-cas/src/stall.ts`).
- **Record sends and drops in one ordered list.** Two arrays cannot answer
  "did the result reach the party before their sockets closed", which is the
  only question `endDropDelayMillis` is about.

## Env-gated integration tests

- A live-stage test lives in the same `test/` directory behind
  `describe.skipIf(!process.env.YYT_KV_BASE_URL || !process.env.YYT_KV_TOKEN)`
  (`packages/kvstore-client/test/integration.test.ts`). **The `describe` body
  still runs when every test is skipped**, so construct the client inside each
  `it` (or a lazy helper), or the suite fails at collection time on the missing
  env instead of skipping.
- Namespace the variables `YYT_*` and give them no default: a default pointed
  at a real stage is a network test that runs by accident.
- The fixtures such a test needs on dev (a project, an auth channel, the
  collections, a player JWT) are provisioned and torn down by a scratch script
  — see [manual-verification.md](manual-verification.md) — never committed.

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

## Scripted TCP peer for recovery paths

- A real Redis cannot be told to answer `-ERR` to one `AUTH` and `-NOAUTH`
  to the next `GET`, so recovery is tested against a `node:net` server that
  records every inbound line and replies per connection number
  (`packages/naive-redis/test/auth-recovery.test.ts`). Assert the whole
  `received` array (`[AUTH, GET, AUTH, GET]`) and the connection count; that
  is what pins "reconnected once and re-authenticated first".
- A regex `fulfill` on `NaiveSocket.send` uses its first capture group; a
  pattern without one never fulfils and the test times out for no visible
  reason.
- That peer lives in `packages/naive-redis/test/fake-redis.ts` and is shared;
  its `reply` may return `undefined` and write later through the `client` it is
  handed, which is how a slow round trip is scripted. `clientAt(n)` reaches the
  nth accepted socket, which is how a push frame is delivered to a subscriber
  on the connection a test cares about.
- Answer per connection number to make a recovery loop observable: refuse the
  `AUTH` on connection 1 and accept it on connection 2, then assert
  `connections`, the tail of `received` (`AUTH` before `SUBSCRIBE`), and a
  message arriving on the new socket. "It reconnected" and "the new connection
  is usable" are different claims and both are the point.
- A recovery loop needs a _stale outcome_ test as well as a happy one: let the
  first connection take the command and die without answering, so the write is
  replayed on the second connection and its rejection arrives while a healthy
  socket is in hand. Assert the connection count did not grow again and that
  the live subscription still delivers.
- Pair every automatic-retry test with one that shuts the thing down and
  asserts the count stops moving. That is the test that caught a scheduled
  retry outliving `disconnect()`, which no amount of testing the happy loop
  would have surfaced.
- For CAS backends, the race test is the same shape everywhere: wrap the
  repository so the first `compareAndSet` awaits the other writer, then
  assert both writers' keys survive and the version advanced twice
  (`packages/repository/test/repository.test.ts` "keeps both writers'
  changes"). Copy that pattern into a new backend rather than inventing a
  weaker one.

## Testing a timeout that is supposed to restart

- The interesting case is a request whose total wall time exceeds its budget
  while the part the budget describes does not. Build it from two delays: a
  request written **ahead** of yours (`urgent: true`, the shape `AUTH` takes on
  every reconnect) answered in 100 ms, and yours answered 100 ms after it
  reaches the wire, against a 150 ms budget. Under the old rule it rejects;
  under the new one it resolves, with 50 ms of margin on either side.
- Pair it with the test for the bound: a peer that swallows the request and
  drops the connection forever. It must still end in a timeout — that is what
  rejects "re-arm on every write", which otherwise passes everything else.
- Also keep a plain "the server never answers" case. A restarted clock that is
  never armed again looks identical to a correct one until you ask for it.
- And pin the limit the restart does **not** remove: three pipelined requests
  with a budget shorter than the head's round trip still leave the third
  rejected unwritten. Without that test the docs quietly grow a claim the code
  never made.
- Order a race by waiting for the state, not by sleeping a guessed interval.
  A `setTimeout(40)` meant to land while a request is in flight keeps passing
  once it starts landing after the reply — it just stops testing anything.
  Poll the recorded server messages instead.
- Assert against `dist`, not only `src`: a workspace package imports its
  dependency through the symlink to `dist`, so a fix in `naive-socket/src` is
  invisible to a `naive-redis` test until `pnpm build` runs. A test that fails
  for that reason looks exactly like a wrong fix.

## Binary payloads and conformance vectors

- vitest's generic `toEqual` walks a typed array element by element: about
  170 ms per 130 KB. `asset-client`'s tests register
  `expect.addEqualityTesters` with a `Buffer.equals` tester, which took the
  suite from 15 s to under one; do the same before comparing many buffers.
- A decryptor is tested against ciphertexts it did not make. The tests carry an
  independent node:crypto encryptor written from the spec (`test/encrypt.ts`)
  for arbitrary sizes and paths, and the service repository's conformance
  vectors, copied verbatim with the source commit noted, `-diff` in
  `.gitattributes` and excluded in `.prettierignore` (Prettier would rewrap
  1.2 MB of hex). The encryptor reproducing every vector byte for byte is what
  proves it agrees with the Go one.
- Test every tampering through every read shape, not only the whole-file one:
  the empty-window bug above passed a tamper matrix that only ever called
  `read()`.

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
