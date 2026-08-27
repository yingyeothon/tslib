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

## Transport seams

- Anything that talks to a specific cloud service belongs behind an
  interface in the package that owns the abstraction, with the vendor call
  in a `create*Transport` factory next to it (`lambda-gamebase`'s
  `Transport`, `createApiGatewayTransport`, `createRedisPubSubTransport`).
- Encoding belongs to the implementation, not the caller: `reply`/`broadcast`
  hand over the value and never serialize, which is what lets a transport
  pick JSON, a binary codec, or an envelope of its own.
- Say what a boolean means per implementation. `createRedisPubSubTransport`
  returns "a gateway was subscribed", not "the client received it", so
  policies keyed on delivery must not be pointed at it.

## Widening a seam without breaking it

- An optional capability on an interface needs a fallback at the call site, not
  a second interface. `Transport.sendMany` is optional and `broadcast` prefers
  it when present, so a transport with no cheaper multi-target form simply
  omits it and nothing else changes.
- Keep the result shape identical across both paths. `broadcast` returns the
  same `RespondResult` whether it fanned out in one call or looped, so callers
  never learn which happened.
- A union that is not discriminable by its tag needs the fields spelled out
  as `never` on the other members. `GatewayCommand`'s two `send` shapes both
  answer to `op: "send"`, so each denies the other's field and a consumer
  narrows with a plain property check.
- A configuration knob must be wired where it can act. `queueTtlSeconds` on
  the actor's own subsystem is dead: only a _producer_ pushes, so only a
  producer can re-apply a TTL. Trace an option to the call it changes before
  documenting it as a safeguard.
- A default that is unsafe should not exist. `RedisLockOptions.lockTimeout` is
  **required** rather than defaulting to "no expiry": a lock that never expires
  deadlocks its actor forever when the holder crashes, so that has to be a
  choice someone typed. Requiring the field is the enforcement; a doc comment
  is not.

## Option shapes

- When a seam's whole space is closed and enumerable, make the option **data**,
  not a callback. `AuthorizationSource` is a union of
  `{from:"header"|"queryString"|"subprotocol", name?}` rather than a family of
  reader factories: it is inspectable, trivially testable, has no naming
  problem, and mirrors the vocabulary API Gateway already uses. Reach for a
  callback only where the space is genuinely open (`resolveMemberId`,
  `selectSubprotocol`, `buildContext`).
- A type-level restriction on an options field is documentation, not
  enforcement. `Omit<VerifyOptions, "complete">` only rejects an object
  _literal_; a variable or a spread carries the key straight through to the
  library underneath. If a field would break the contract, override it at
  runtime as well and say why in a comment.
- Adding an option must leave current behavior intact when it is unset, and
  the default belongs in the destructuring so it reads next to the type.
- Say what a callback receives when it is not obvious from the name.
  `selectSubprotocol(offered)` is handed `["bearer", "<the raw JWT>"]` for the
  arrangement the README recommends — a credential crossing an extension
  point needs a warning at the extension point, not only in the docs.

## Naming a factory that returns a handler

`CONVENTIONS.md` reserves `create*Handler` for factories whose product is
incidentally a handler. An authorizer _is_ the thing being constructed, so the
family stays `createAuthorizer` / `createRequestAuthorizer` /
`createJwtAuthorizer` / `createJwtRequestAuthorizer`, as fixed by the v2
rename. Keep new authorizers in that shape; do not rename them to `*Handler`.

## Layering

- Leaf packages (`codec`, `logger`, `repository`, `naive-socket`,
  `event-broker`, `s3-cache-bridge-client`, `gamebase-client`) must not depend
  on anything in the workspace beyond each other's leaves.
- A package that must run in a browser (`gamebase-client`) types the WHATWG
  globals it uses (`WebSocketLike`, `FetchLike`) itself and reads
  `globalThis.WebSocket` / `fetch` only as a default behind an injectable
  option. The DOM lib and `undici-types` are both off-limits in a public
  `.d.ts`: the first is not in `tsconfig.base.json`, the second would become a
  runtime dependency (see `tooling.md`). No `node:` imports there either.
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
