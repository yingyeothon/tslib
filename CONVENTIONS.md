# API conventions (v2)

These rules apply to every package in this monorepo. They were fixed on 2026-08-20
before the first tslib release (v2.0.0+); all breaking changes are allowed until then.

## Shape: functions, not classes

- **No exported classes.** Every stateful resource is described by an exported
  `interface` and constructed with a `create*` factory function, e.g.
  `createNaiveSocket(options: NaiveSocketOptions): NaiveSocket`.
- Factories always use the `create*` prefix (never `new*`, `get*`, `build*`, `use*`).
  `get*`/`set*` is reserved for accessors of existing state; plain verbs
  (`enqueue`, `redisGet`, `handleConnect`) stay for do-the-work functions.
- `handle*` is reserved for functions that _perform_ handling when called.
  A factory that _returns_ a handler is `create*Handler`.
- Stateless singletons may be exported as `const` values (e.g. `jsonCodec`,
  `nullLogger`, `consoleWriter`).

## Parameters

- A function with more than two parameters, or with any optional parameter,
  takes a **single options object**. One or two required, self-evident
  parameters may stay positional (`sleep(millis)`, `redisGet(connection, key)`).
- Options interfaces are named `<FunctionName minus create>Options`
  (`createRedisSubsystem` → `RedisSubsystemOptions`). No `*Arguments`, `*Args`,
  `*Env` suffixes.
- Mixed positional-plus-trailing-options is allowed only as
  `(requiredMainThing, options?)`.

## Logger

- The only logger contract is `Logger` / `LogWriter` from `@yingyeothon/logger`
  (`debug`, `info`, `warn`, `error`, variadic args; `Logger` adds `severity`).
- Every package that logs accepts an optional `logger?: Logger` in its options
  and defaults to `nullLogger`. No `console.*` fallbacks, no env-gated console
  output, no package-local logger interfaces or duplicates.
- Call style: message first, structured context after —
  `logger.info("actor started", { actorId })`.

## Environment variables

- Library code never reads `process.env` directly. All configuration is
  injected via options.
- For convenience a package may export an explicit helper named
  `<name>OptionsFromEnv()` (e.g. `gamebaseOptionsFromEnv()`) that reads the
  documented variables and returns an options object; calling it is the
  caller's choice.

## Unchanged invariants

Named exports only via `src/index.ts`; `"type": "module"` dual build; version
stays `0.0.0` in git; see `.github/workflows` and root configs.
