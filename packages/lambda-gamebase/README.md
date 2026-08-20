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

Environment variables: `REDIS_HOST`, `REDIS_PASSWORD` (optional), `WS_ENDPOINT` (API Gateway management endpoint), `GAME_ACTOR_LAMBDA_NAME`, and `IS_OFFLINE` for serverless-offline development.

## Usage

ESM:

```ts
import {
  handleActor,
  handleConnect,
  handleDisconnect,
  handleMessages,
  broadcast,
  setupBaseGameContext,
  type BaseGameRequest,
  type GameActorStartEvent,
} from "@yingyeothon/lambda-gamebase";

// Game actor Lambda: runs the game loop as an actor.
export async function actor(event: GameActorStartEvent) {
  await handleActor<BaseGameRequest>({
    event,
    eventKeyPrefix: "game:event:",
    awaiterKeyPrefix: "game:awaiter:",
    queueKeyPrefix: "game:queue:",
    lockKeyPrefix: "game:lock:",
    lifetimeSeconds: 300,
    gameMain: async ({ gameId, members, pollMessages }) => {
      const context = setupBaseGameContext(members);
      const messages = await pollMessages();
      await broadcast(Object.keys(context.connectedUsers), { type: "tick" });
    },
  });
}

// WebSocket $connect handler.
export const connect = (event) =>
  handleConnect({
    event,
    connectionIdAndGameIdKeyPrefix: "game:conn:",
    actorEventKeyPrefix: "game:event:",
    actorQueueKeyPrefix: "game:queue:",
  });
```

CJS:

```js
const { reply, dropConnection } = require("@yingyeothon/lambda-gamebase");

await reply(connectionId, { type: "hello" }); // false when undeliverable
await dropConnection(connectionId);
```

## Public API

Actor loop

- `handleActor` / `HandleActorArgs` — game actor Lambda entry point: persists the start event, signals the lobby, runs the actor loop
- `startActorLoop` / `StartActorLoopArgs` — runs `gameMain` inside the actor event loop and clears the start event at the end
- `newActorSubsys` / `NewActorSubsysArgs` / `ActorSubsystem` — Redis-backed queue/lock/awaiter with per-component key prefixes
- `saveActorStartEvent`, `loadActorStartEvent`, `clearActorStartEvent` — start-event persistence helpers
- `readyCall` — HTTP PUT ready signal to the lobby callback URL
- `GameActorStartEvent` (type)

API Gateway handlers

- `handleConnect` / `HandleConnectArgs` — validates `x-game-id` / `x-member-id`, maps the connection, enqueues `enter`
- `handleDisconnect` / `HandleDisconnectArgs` — enqueues `leave` and removes the mapping
- `handleMessages` / `HandleMessagesArgs` — validates the client message and enqueues it stamped with the connection id
- `handleDebugStart` / `HandleDebugStartArgs` — serverless-offline only: releases the actor lock and invokes the actor Lambda locally

Networking

- `reply`, `broadcast`, `dropConnection`, `fakeConnectionId`, `isGoneException`, `NetworkOptions` (type), `RespondResult` (type)
- `getApiGatewayManagementClient`, `setApiGatewayManagementClient` — shared API Gateway management client (lazy; injectable for tests)

Infrastructure

- `env` / `GamebaseEnv` (type) — lazy environment configuration
- `getRedisConnection`, `setRedisConnection` — shared Redis connection (lazy; injectable for tests)
- `useRedis` — short-lived Redis connection helper

Models and requests (types)

- `BaseGameContext`, `BaseGameUser`, `BaseGameObserver`, `GameStartMember`, `GameMainArguments`
- `BaseGameRequest`, `BaseGameEnterRequest`, `BaseGameLeaveRequest`, `BaseGameConnectionIdRequest`

Support

- `setupBaseGameContext`, `sleep`, `Ticker`, `TimeDelta`

## Migrating from the legacy package

- All exports are named; there are no default exports. Interfaces (`BaseGameContext`, `GameActorStartEvent`, ...) are type-only exports.
- **AWS SDK v2 → v3.** `reply` and `dropConnection` now use `ApiGatewayManagementApiClient` with `PostToConnectionCommand` / `DeleteConnectionCommand`, and `handleDebugStart` uses `LambdaClient` with `InvokeCommand`. A disconnected WebSocket client no longer surfaces as an error with `statusCode === 410`; SDK v3 throws `GoneException` instead. `reply` still returns `false` for a gone client so disconnect processing is unchanged, and the new `isGoneException(error)` helper detects this case (`error instanceof GoneException` or `error.name === "GoneException"`). `dropConnection` now treats an already-gone connection as success.
- The eagerly created `redisConnection` export was replaced by lazy `getRedisConnection()` (plus `setRedisConnection()` for tests), so importing the package no longer opens a socket. The API Gateway client is likewise lazy via `getApiGatewayManagementClient()`.
- Handlers and the actor loop accept optional injection points (`redisConnection`, `subsys`, `lambdaClient`, `logger`, `saveStartEvent`, `deleteStartEvent`, `NetworkOptions.client`) for testing; defaults preserve the legacy behavior.
- `newActorSubsys` builds `RedisQueue` / `RedisLock` / `RedisAwaiter` classes from `@yingyeothon/actor-system-redis-support` instead of the removed factory-function deep imports.
- Bug fixes: `dropConnection` now actually awaits the SDK call (the legacy version forgot to), and `broadcast` returns the documented `{ [connectionId]: delivered }` map (the legacy version accidentally merged `{ connectionId, success }` objects).
- `handleDebugStart` no longer lets a fire-and-forget invocation reject unhandled; the failure is logged.
