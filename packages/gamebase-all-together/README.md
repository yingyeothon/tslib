# @yingyeothon/gamebase-all-together

A ready-made `gameMain` for `@yingyeothon/lambda-gamebase` for games everyone plays together: a **wait** stage that processes enter/leave messages until every user is connected (or the waiting time runs out), a **running** stage that drives your game controller until the game is over (or the running time runs out), and an **end** stage that broadcasts the result and drops every remaining connection. The stage and its age in seconds are broadcast to all connected users once per second as `{ type: "stage", payload: { stage, age } }`.

This package was formerly published as `@yingyeothon/do-game-all-together`.

## Install

```bash
npm install @yingyeothon/gamebase-all-together @yingyeothon/lambda-gamebase
```

## Usage

ESM:

```ts
import { runGameAllTogether } from "@yingyeothon/gamebase-all-together";
import {
  createGamebaseContext,
  gamebaseOptionsFromEnv,
  handleActor,
  type BaseGameRequest,
  type GameActorStartEvent,
} from "@yingyeothon/lambda-gamebase";

type MoveMessage = { type: "move"; connectionId: string; x: number };
type GameMessage = BaseGameRequest | MoveMessage;

// One context per Lambda container: owns the Redis connection and the
// API Gateway management client.
const context = createGamebaseContext(gamebaseOptionsFromEnv());

export async function actor(event: GameActorStartEvent) {
  await handleActor<GameMessage>({
    event,
    context,
    eventKeyPrefix: "game:event:",
    awaiterKeyPrefix: "game:awaiter:",
    queueKeyPrefix: "game:queue:",
    lockKeyPrefix: "game:lock:",
    lifetimeSeconds: 300,
    gameMain: (options) =>
      runGameAllTogether<GameMessage>({
        ...options,
        network: { context },
        gameWaitingSeconds: 30,
        gameRunningSeconds: 180,
        loopInterval: 100,
        isGameOver: ({ context }) =>
          Object.keys(context.connectedUsers).length === 0,
        processMessage: async ({ context, message }) => {
          // Apply a game message to your own state.
        },
        updateTimeDelta: async ({ context, delta }) => {
          // Optional per-message physics/simulation update (delta in seconds).
        },
      }),
  });
}
```

CJS:

```js
const {
  GameStage,
  runGameAllTogether,
} = require("@yingyeothon/gamebase-all-together");
console.log(GameStage.Wait, GameStage.Running, GameStage.End);
```

## Public API

- `runGameAllTogether` / `RunGameAllTogetherOptions` (type) — the wait → running → end game loop; a drop-in `gameMain` for `handleActor`. Pass `network: { context }` (or an explicit `client`) so broadcasts and connection drops reach API Gateway; `logger` defaults to `nullLogger`.
- `GameStage` — enum `Wait = "wait"`, `Running = "running"`, `End = "end"`
- `GameController` (type) — `isGameOver`, `processMessage`, optional `updateTimeDelta`
- `GameMessageBase` (type) — `{ type: string; connectionId: string }`, the constraint for the message type parameter `M`
- `doInStageWait` / `DoInStageWaitOptions` (type) — the wait stage; resolves `true` when every user connected in time
- `doInStageRunning` / `DoInStageRunningOptions` (type) — the running stage loop
- `broadcastStage` / `BroadcastStageOptions` (type) — broadcasts `{ type: "stage", payload: { stage, age } }` to connected users
- `processEnterLeave`, `processEnter`, `processLeave` (+ `ProcessEnterLeaveOptions`, `ProcessEnterOptions`, `ProcessLeaveOptions` types) — enter/leave bookkeeping on the base game context

## Migrating from the legacy package

- The npm package was renamed: `@yingyeothon/do-game-all-together` → `@yingyeothon/gamebase-all-together`.
- Options types follow the monorepo `*Options` convention: `RunGameAllTogetherArgs` → `RunGameAllTogetherOptions`, and every exported function's options object now has a named, exported `*Options` type (`DoInStageWaitOptions`, `DoInStageRunningOptions`, `BroadcastStageOptions`, `ProcessEnterOptions`, `ProcessLeaveOptions`, `ProcessEnterLeaveOptions`). Function names are unchanged.
- `@yingyeothon/lambda-gamebase` no longer keeps module-singleton network clients. Pass `network: { context }` (a `GamebaseContext` from `createGamebaseContext`) or `network: { client }` in `RunGameAllTogetherOptions` — it is threaded to every `broadcast`/`dropConnection` call. Without it, network calls fall back to environment-independent defaults and will fail outside tests.
- Logging: `logger` now defaults to `nullLogger` (previously a debug-level console logger); pass `createConsoleLogger("debug")` from `@yingyeothon/logger` to restore the old behavior. Log calls use the message-first style `logger.info("Game end", { gameId })` instead of the pino-style context-first form.
- All exports are named; there are no default exports. `GameController` moved to a root export (it was a deep import from `services/doInStageRunning` before), and the stage helpers (`doInStageWait`, `doInStageRunning`, `broadcastStage`, `processEnter*`) are now part of the public surface.
- The message type parameter `M` is now constrained by `GameMessageBase` (`{ type: string; connectionId: string }`) instead of `BaseGameRequest`. The legacy constraint made it impossible to type game-specific messages (the whole point of `processMessage`); every legacy-valid `M` still satisfies the new constraint. Runtime dispatch is unchanged: `enter`/`leave` go to enter/leave processing, everything else to `processMessage`.
- Behavior is otherwise unchanged. Note that the underlying `@yingyeothon/lambda-gamebase` moved to AWS SDK v3: a gone WebSocket client now surfaces as `GoneException` instead of a `statusCode === 410` error, but `broadcast`/`dropConnection` still report such connections as undelivered/dropped, so this package's enter/leave and end-of-game processing behaves as before.
