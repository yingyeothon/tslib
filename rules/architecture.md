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
- Every runtime Redis key carries a TTL, and "no TTL" is not an option.
  `RedisQueueOptions.ttlSeconds` is **required** and `createRedisQueue`
  throws on a non-positive value: on a shared `allkeys-lru` Redis a key that
  never expires evicts someone else's first, and a queue pushed by something
  other than the gateway must still expire. Handlers that push take
  `queueTtlSeconds` required; `handleActor` (which only drains) defaults its
  own to the alive window. `repository-redis` `set()` throws for the same
  reason (use `setWithExpire`; the document helpers take `expiresInMillis`).
- A default that is unsafe should not exist. `RedisLockOptions.lockTimeout` is
  **required** rather than defaulting to "no expiry": a lock that never expires
  deadlocks its actor forever when the holder crashes, so that has to be a
  choice someone typed. Requiring the field is the enforcement; a doc comment
  is not.

## Conditional writes (`CasRepository`)

- Read-modify-write on a shared key needs a conditional write, not a version
  field the writer trusts by itself. `Repository` gains an optional
  `CasRepository` extension: `getRevision` returns an opaque `token`, and
  `compareAndSet(key, expectedToken, value)` writes only while the key still
  holds that revision (`undefined` = must be absent).
- The token is whatever the backend can check atomically, never something
  the caller computes: an ETag for S3 (`If-Match` / `If-None-Match: *`), a
  random `rev` attribute for DynamoDB (`ConditionExpression`), a SHA-1 of the
  stored bytes for Redis (Lua `redis.sha1hex`) and memory. Comparing a
  serialized payload from JavaScript would tie the check to codec determinism.
- `ListDocument`/`MapDocument` use CAS when the repository has it, retry from
  a fresh read (`maxRetries`, default 3), then throw. Without CAS they stay
  last-writer-wins and the README says so; do not add a silent fallback that
  looks like a guarantee.
- A failed conditional write is still a billed request on S3 (a PUT) and
  DynamoDB (one WCU), the same as the unconditional write it replaces, so
  cost is not a reason to leave a backend out. Check the installed SDK types
  before declaring a vendor feature unavailable.

## Connection recovery

- A connection that can be poisoned must reset itself, not report forever.
  `naive-redis` drops the socket when `AUTH` fails or times out and when any
  reply is `-NOAUTH`/`-WRONGPASS`, so the next command reconnects and
  authenticates again; a command that hit `-NOAUTH` is retried once. Before
  this, a Redis restart left every warm Lambda container answering
  `-NOAUTH` until it was recycled.
- The command that performs the recovery (`AUTH`) must be excluded from the
  recovery path (`recoverAuthentication: false`), or a wrong password
  reconnects recursively.
- A frozen Lambda container resumes with the peer's FIN/RST already on the
  socket but not yet dispatched, so the invocation's first `send` still sees
  `Connected`. `NaiveSocket` checks `destroyed`/`readableEnded`/
  `writableEnded` before writing and reconnects at once; when the flags are
  still clear and the kernel answers the write with `EPIPE`/`ECONNRESET`
  (`ERR_STREAM_WRITE_AFTER_END`, `ERR_STREAM_DESTROYED`), the head work is
  requeued and resent once — nothing of it reached the peer. Found on the
  yyt dev stage right after the `-NOAUTH` fix: the same Valkey restart then
  failed with `writeAfterFIN` from `saveActorStartEvent`. Verified by
  `tslib/scripts/link-service.mjs link`, deploying both samples, restarting
  the store and re-running the smokes on warm containers.
- `NaiveSocket.disconnect(reason?)` passes the cause to the pending requests;
  a bare `DeadSocket` hides why the caller's command died.
- Socket event handlers are bound to the socket that raised them. `destroy()`
  emits `close` on a later tick, so a `send` issued right after `disconnect()`
  has already opened the next socket; the stale `close` must not trigger a
  reconnect loop against the new one.

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

## Mirroring a Go wire protocol

- `gamebase-client`'s types mirror the gateway's Go structs, **including the
  JSON tags**. Two things a TypeScript reading of the README gets wrong:
  a Go `string` field refuses a JSON number for the whole frame (`dir` was
  typed `number` in 2.0.0 and every `pos` carrying it was dropped as
  `bad_message`), and `omitempty` means the field is simply absent — so a
  required field in the SDK type is a lie unless the client fills it in
  (`normalizePartyFrame` for `leaderId`/`invited`/`max`).
- When checking a wire type, open `gateway/internal/lobby/protocol.go` in the
  service repo, not only its README. A smoke that never sends the optional
  field (`dir`) does not catch a type mismatch; the test that sends it does.

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
- Backend adapters (`repository-redis`, `repository-s3`, `repository-dynamodb`, `actor-system-redis`,
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
