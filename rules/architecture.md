# Architecture & API Design

`CONVENTIONS.md` at the repo root is canonical. This file records the operational
consequences of those rules.

## Shape

- No exported classes. Describe stateful resources with an exported `interface`
  and construct them with a `create*` factory.
- `create*` for factories; `get*`/`set*` only for accessors of existing state;
  plain verbs (`enqueue`, `redisGet`) for do-the-work functions.
- `handle*` performs handling; a factory returning a handler is `create*Handler`.
- Stateless singletons ship as `const` (`jsonCodec`, `nullLogger`, `consoleWriter`).
- Options interfaces are named `<FactoryName minus create>Options`. No `*Args`,
  `*Arguments`, `*Env` suffixes.
- More than two parameters, or any optional parameter → one options object.
  Mixed form is allowed only as `(requiredMainThing, options?)`.

## Dependency injection over ambient state

- Library code never reads `process.env`, never calls `console.*`, never reaches
  for a global clock or global singleton.
- Configuration arrives through options. A package may export exactly one
  `<name>OptionsFromEnv()` helper for callers who want env wiring; only that
  helper touches `process.env`.
- Logging goes through `Logger`/`LogWriter` from `@yingyeothon/logger`, accepted
  as optional `logger?: Logger` and defaulting to `nullLogger`. Call style is
  message first, structured context second: `logger.info("actor started", { actorId })`.
- These seams are also the test seams — see [testing.md](testing.md).

## Package layout

- Public API is named exports from `src/index.ts` only. No deep import paths;
  the legacy `pkg/lib/foo` entry points are intentionally gone.
- `packages/<name>/` holds `src/`, `test/`, `README.md`, `package.json`,
  `tsconfig.json` (extends `../../tsconfig.base.json`), and a `vitest.config.ts`
  only when the package needs one (e.g. Redis containers).
- `package.json` build script is always `tsup --config ../../tsup.config.base.ts`.
  Do not add per-package tsup configs without a concrete reason.
- Cross-package deps use `workspace:^` and must stay acyclic. Update the mermaid
  dependency graph in the root `README.md` when an edge changes.

## Layering

- Leaf packages (`codec`, `logger`, `repository`, `naive-socket`,
  `event-broker`, `s3-cache-bridge-client`) must not depend on anything in the
  workspace beyond each other's leaves.
- Backend adapters (`repository-redis`, `repository-s3`, `actor-system-redis`,
  `actor-system-lambda`) implement an abstraction defined in the leaf package.
  Put the interface in the abstraction package, never in the adapter.
- Keep protocol/serialization logic (RESP framing, codecs, policy building) pure
  and IO-free so it is unit-testable without a socket or an AWS client.

## Naming history (do not regress)

The v2 unification renamed packages to a consistent `<domain>-<tech>` shape:
`slack-logger` → `logger-slack`, `actor-system-redis-support` →
`actor-system-redis`, `actor-system-aws-lambda-support` → `actor-system-lambda`,
`aws-lambda-custom-authorizer` → `lambda-authorizer`,
`aws-lambda-jwt-custom-authorizer` → `lambda-authorizer-jwt`,
`do-game-all-together` → `gamebase-all-together`. Keep new package names in that
shape, and never resurrect the old names or the `*-support` suffix.

The same pass removed the pre-v2 API dialects: `new RedisQueue()`/`new
S3Repository()` classes, `build*`/`new*`/`get*` factories, per-package logger
interfaces (`ActorSystemLogger`), and ad-hoc `*Env` objects that read
`process.env`. If a review turns one of these up, it is a regression.
