# @yingyeothon/lambda-gamebase

Serverless WebSocket game framework on AWS Lambda: an actor-based game loop backed by Redis, API Gateway WebSocket connection handling (`$connect`, `$disconnect`, `$default`), broadcasting/replying to connections, and the base game context/user/observer models shared by game implementations.

## Install

```bash
npm install @yingyeothon/lambda-gamebase
```

AWS SDK v3 clients are peer dependencies:

```bash
npm install @aws-sdk/client-apigatewaymanagementapi @aws-sdk/client-lambda
```

Library code never reads `process.env`. Configuration is injected as a `GamebaseOptions` object; the `gamebaseOptionsFromEnv()` helper reads the documented variables (`REDIS_HOST`, `REDIS_PORT`, `REDIS_USER` (ACL user, optional), `REDIS_PASSWORD` (optional), `WS_ENDPOINT` (API Gateway management endpoint), `GAME_ACTOR_LAMBDA_NAME`, and `IS_OFFLINE` for serverless-offline development) if you want to keep configuring via environment.

## Usage

ESM:

```ts
import {
  broadcast,
  createGamebaseContext,
  gamebaseOptionsFromEnv,
  handleActor,
  handleConnect,
  handleDisconnect,
  handleMessages,
  setupBaseGameContext,
  type BaseGameRequest,
  type GameActorStartEvent,
} from "@yingyeothon/lambda-gamebase";
import type { APIGatewayProxyEvent } from "aws-lambda";

// One context per Lambda container: it owns the lazily created shared
// Redis connection and API Gateway management client.
const context = createGamebaseContext(gamebaseOptionsFromEnv());

// Game actor Lambda: runs the game loop as an actor.
export async function actor(event: GameActorStartEvent) {
  await handleActor<BaseGameRequest>({
    event,
    context,
    eventKeyPrefix: "game:event:",
    awaiterKeyPrefix: "game:awaiter:",
    queueKeyPrefix: "game:queue:",
    lockKeyPrefix: "game:lock:",
    lifetimeSeconds: 300,
    gameMain: async ({ gameId, members, pollMessages }) => {
      const gameContext = setupBaseGameContext(members);
      const messages = await pollMessages();
      await broadcast(
        Object.keys(gameContext.connectedUsers),
        { type: "tick" },
        { context },
      );
    },
  });
}

// WebSocket $connect handler. `resolveMemberId` and `selectSubprotocol`
// are what make this safe to expose — see Security below.
export const connect = (event: APIGatewayProxyEvent) =>
  handleConnect({
    event,
    context,
    connectionIdAndGameIdKeyPrefix: "game:conn:",
    actorEventKeyPrefix: "game:event:",
    actorQueueKeyPrefix: "game:queue:",
    resolveMemberId: (connecting) => {
      const memberId: unknown =
        connecting.requestContext.authorizer?.["memberId"];
      return typeof memberId === "string" ? memberId : undefined;
    },
    selectSubprotocol: (offered) =>
      offered.includes("bearer") ? "bearer" : undefined,
  });
```

Without `resolveMemberId` the member id is whatever the client put in
`x-member-id`, which is not authentication. Read **Security** before
deploying a `$connect` handler.

CJS:

```js
const {
  createGamebaseContext,
  dropConnection,
  gamebaseOptionsFromEnv,
  reply,
} = require("@yingyeothon/lambda-gamebase");

const context = createGamebaseContext(gamebaseOptionsFromEnv());
exports.hello = async (connectionId) => {
  await reply(connectionId, { type: "hello" }, { context }); // false when undeliverable
  await dropConnection(connectionId, { context });
};
```

## Public API

Actor loop

- `handleActor` / `HandleActorOptions` — game actor Lambda entry point: persists the start event, signals the lobby, runs the actor loop
- `startActorLoop` / `StartActorLoopOptions` — runs `gameMain` inside the actor event loop and clears the start event at the end
- `createActorSubsystem` / `ActorSubsystemOptions` / `ActorSubsystem` — Redis-backed queue/lock/awaiter with per-component key prefixes
- `saveActorStartEvent`, `loadActorStartEvent`, `clearActorStartEvent` — start-event persistence helpers
- `readyCall` — HTTP PUT ready signal to the lobby callback URL
- `GameActorStartEvent` (type)

API Gateway handlers

- `handleConnect` / `HandleConnectOptions` — resolves the member id (`resolveMemberId`, default `x-member-id`), validates it against `x-game-id`'s start event, maps the connection, enqueues `enter`, and optionally echoes a `Sec-WebSocket-Protocol` (`selectSubprotocol`)
- `handleDisconnect` / `HandleDisconnectOptions` — enqueues `leave` and removes the mapping
- `handleMessages` / `HandleMessagesOptions` — validates the client message and enqueues it stamped with the connection id. Messages whose `type` is reserved are refused with `400`
- `handleDebugStart` / `HandleDebugStartOptions` — serverless-offline only: releases the actor lock and invokes the actor Lambda locally

Networking

- `reply`, `broadcast`, `dropConnection`, `fakeConnectionId`, `RespondResult` (type) — the calls a game loop makes; each resolves a `Transport` from its `NetworkOptions`
- `Transport` (type) — `{ send(connectionId, message), drop(connectionId) }`. Encoding belongs to the implementation: `reply`/`broadcast` never serialize, so a transport may use JSON, a binary codec, or an envelope of its own
- `NetworkOptions` (type) — `{ transport?, client?, context?, logger?, sendTimeoutMillis? }`; an explicit `transport` wins, otherwise the API Gateway transport is built from `client` or `context`
- `resolveTransport(functionName, options)` — the resolution above, exposed for custom network helpers
- `createApiGatewayTransport(options)` / `ApiGatewayTransportOptions` (type) / `isGoneException` — the default transport: JSON over `PostToConnection`, `DeleteConnection` to drop, and `sendTimeoutMillis` to abort a delivery so one unresponsive connection cannot stall a game tick
- `createRedisPubSubTransport(options)` / `RedisPubSubTransportOptions` (type) / `GatewayCommand` (type) — publishes `{ op: "send" | "drop", ... }` on `{channelPrefix}{gameId}` for deployments that terminate WebSockets in their own gateway process. Subscribe with `createRedisSubscriber` from `@yingyeothon/naive-redis`. Its boolean means "a gateway was subscribed", not "the client received it", so do not pair it with `gamebase-all-together`'s `dropUndeliveredConnections` — a gateway restart would evict the whole party

Infrastructure

- `GamebaseOptions` (type) / `gamebaseOptionsFromEnv()` — injected configuration and the explicit env reader
- `createGamebaseContext` / `GamebaseContext` / `GamebaseContextOptions` — owns the lazily created shared Redis connection and API Gateway management client (both injectable for tests)
- `useRedis(work, connectionOptions)` — short-lived Redis connection helper

Models and requests (types)

- `BaseGameContext`, `BaseGameUser`, `BaseGameObserver`, `GameStartMember`, `GameMainOptions`
- `BaseGameRequest`, `BaseGameEnterRequest`, `BaseGameLeaveRequest`, `BaseGameConnectionIdRequest`
- `reservedRequestTypes` / `isReservedRequestType(type)` — `enter` and `leave` are produced by the connection handlers and decide which member a connection speaks for, so a client may never send them

Support

- `setupBaseGameContext`, `sleep`, `createTicker` / `Ticker` / `TickerOptions`, `createTimeDelta` / `TimeDelta`

## Security

By default `handleConnect` reads `memberId` from the client's `x-member-id`
header or query string and only checks that it appears in the game's start
event. That is not authentication: **anyone who knows another member's id
can connect as that member** — and `gamebase-all-together` broadcasts every
member id to every player by default, so ids are not secret.

Close it with `resolveMemberId`. Put a REQUEST authorizer on `$connect`
(see [`@yingyeothon/lambda-authorizer-jwt`](../lambda-authorizer-jwt) —
a WebSocket API supports no other _Lambda_ authorizer type) and read the
verified identity from its context:

```ts
await handleConnect({
  event,
  ...prefixes,
  resolveMemberId: (event) => {
    const memberId: unknown = event.requestContext.authorizer?.["memberId"];
    return typeof memberId === "string" ? memberId : undefined;
  },
  selectSubprotocol: (offered) =>
    offered.includes("bearer") ? "bearer" : undefined,
  context,
});
```

`resolveMemberId` returning `undefined` rejects the connection, so the
authenticated path fails closed. The `x-member-id` header is then ignored
entirely; only `x-game-id` still comes from the client, and membership is
still checked against the start event, so a verified member can only enter
a game it was actually invited to.

`selectSubprotocol` echoes the `Sec-WebSocket-Protocol` value the server
selected. A browser cannot set headers on a WebSocket handshake, so a token
usually travels as `new WebSocket(url, ["bearer", token])`; the browser
then aborts the handshake unless the server names the subprotocol it chose.
A selection the client did not offer is dropped and logged rather than
sent, because a browser would abort on that too.

Note what the callback receives: with the arrangement above the `offered`
array is `["bearer", "<the raw JWT>"]`. **It carries the credential — never
log it.**

`handleMessages` refuses `enter`/`leave` from a client so that `$default`
cannot be used to rebind a connection to another member. It otherwise
routes purely by `connectionId`, and the member that connection speaks for
was decided at `$connect`.

Two things this does **not** close, because neither is an identity
question:

- **A member may hold several connections at once.** Nothing caps them, and
  each `$connect` enqueues an `enter`, whose default `onMemberEntered`
  broadcasts to everyone. Rate-limit connections per member upstream.
- **A superseded connection keeps its mapping.** When a member reconnects,
  `processEnter` rebinds the game slot to the new connection id, but the
  old connection's `connectionId` → `gameId` entry lives until it
  disconnects or the entry expires, so `$default` still accepts messages
  from it. Close the old socket, or have the game ignore a message whose
  connection is no longer the member's current one.

Once a connection is established no authorizer can revoke it. Dropping a
player mid-game is the game loop's job, through `Transport.drop`.

## Behavior changes

- **`Transport` seam.** `reply`/`broadcast`/`dropConnection` now go through a
  `Transport` instead of calling the API Gateway SDK directly. Passing
  `client` or `context` behaves exactly as before; `NetworkOptions.transport`
  replaces it, and the "requires either client or context" error became
  "requires either transport, client, or context".
- **Reserved message types.** `handleMessages` answers `400` for a client
  message whose `type` is `enter` or `leave`. Those are produced by
  `handleConnect`/`handleDisconnect` and decide which member a connection is
  bound to, so accepting one from a client let an authenticated member bind
  another member's game slot to its own connection.
- **Authenticated identity.** `handleConnect` takes `resolveMemberId`, which
  defaults to today's `x-member-id` header or query string read, so unset it
  behaves exactly as before. Pass a resolver reading the authorizer's context
  to close the identity gap described under Security.
- **Subprotocol echo.** `handleConnect` takes `selectSubprotocol`, and returns
  a `Sec-WebSocket-Protocol` response header when it selects one. Unset, the
  response is unchanged.
- **Case-insensitive headers.** `x-game-id` and `x-member-id` are now matched
  regardless of header casing; a client sending `X-GAME-ID` used to be
  rejected. Query string lookup is still exact. A header present but empty
  now falls through to the query string, where it used to win and fail the
  request; and `event.headers` being absent no longer throws. Two headers
  differing only in case resolve to the first one declared.
- **Less in the logs.** Neither `handleConnect` nor `handleDebugStart` logs a
  whole start event any more — it carries every member's name and email.
  `handleMessages` logs a parse failure's `Error.name` rather than the error,
  whose message quotes the body it choked on. The membership rejection still
  names the member and the connection, which under `resolveMemberId` is a
  verified principal and the only way to attribute a probe.
- **Distinct refusal messages.** A missing member id (which is what a
  `resolveMemberId` finding no identity produces) and a missing game id are
  now logged apart, instead of both as "invalid gameId".

## Migrating from the legacy package

- All exports are named; there are no default exports. Interfaces (`BaseGameContext`, `GameActorStartEvent`, ...) are type-only exports.
- **AWS SDK v2 → v3.** `reply` and `dropConnection` now use `ApiGatewayManagementApiClient` with `PostToConnectionCommand` / `DeleteConnectionCommand`, and `handleDebugStart` uses `LambdaClient` with `InvokeCommand`. A disconnected WebSocket client no longer surfaces as an error with `statusCode === 410`; SDK v3 throws `GoneException` instead. `reply` still returns `false` for a gone client so disconnect processing is unchanged, and the new `isGoneException(error)` helper detects this case (`error instanceof GoneException` or `error.name === "GoneException"`). `dropConnection` now treats an already-gone connection as success.
- **No environment reads, no module singletons.** The `env` lazy getter, `getRedisConnection` / `setRedisConnection`, and `getApiGatewayManagementClient` / `setApiGatewayManagementClient` were removed. Build a `GamebaseOptions` (or call `gamebaseOptionsFromEnv()`), pass it to `createGamebaseContext(options)`, and hand that context to the handlers (`context` option) and network functions (`NetworkOptions.context`). The context owns the lazily created shared Redis connection and management client; explicit `redisConnection` / `client` overrides still win. The `GamebaseEnv` type became `GamebaseOptions` with a nested `redis: RedisConnectionOptions`.
- **Renames per the v2 API conventions:**
  - `newActorSubsys` → `createActorSubsystem`, `NewActorSubsysArgs` → `ActorSubsystemOptions`
  - `HandleActorArgs` → `HandleActorOptions`, `StartActorLoopArgs` → `StartActorLoopOptions`, `HandleConnectArgs` → `HandleConnectOptions`, `HandleDebugStartArgs` → `HandleDebugStartOptions`, `HandleDisconnectArgs` → `HandleDisconnectOptions`, `HandleMessagesArgs` → `HandleMessagesOptions`
  - the `subsys` option of `handleActor` / `startActorLoop` → `subsystem`
  - `GameMainArguments` → `GameMainOptions`
  - `Ticker` class → `createTicker({ stage, aliveMillis })` returning the `Ticker` interface; `TimeDelta` class → `createTimeDelta()` returning the `TimeDelta` interface
- **Logger defaults.** Every optional `logger` now defaults to `nullLogger` instead of a console logger, and the `STAGE`-based default severity in `broadcast` / `reply` is gone — pass the logger (e.g. `createConsoleLogger("info")`) you want via options.
- `useRedis(work, { host, password })` with env fallbacks became `useRedis(work, connectionOptions)` with required, explicit `RedisConnectionOptions`.
- `handleDebugStart` now requires a `context`; it reads `isOffline` and `gameActorLambdaName` from `context.options` instead of `IS_OFFLINE` / `GAME_ACTOR_LAMBDA_NAME`.
- Handlers and the actor loop accept optional injection points (`redisConnection`, `subsystem`, `lambdaClient`, `logger`, `saveStartEvent`, `deleteStartEvent`, `NetworkOptions.client`) for testing; defaults preserve the legacy behavior.
- `createActorSubsystem` builds the queue/lock/awaiter with the `createRedisQueue` / `createRedisLock` / `createRedisAwaiter` factories from `@yingyeothon/actor-system-redis`.
- Bug fixes: `dropConnection` now actually awaits the SDK call (the legacy version forgot to), and `broadcast` returns the documented `{ [connectionId]: delivered }` map (the legacy version accidentally merged `{ connectionId, success }` objects).
- `handleDebugStart` no longer lets a fire-and-forget invocation reject unhandled; the failure is logged.
