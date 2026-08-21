# @yingyeothon/gamebase-all-together

A ready-made `gameMain` for `@yingyeothon/lambda-gamebase` for games everyone plays together: a **wait** stage that processes enter/leave messages until enough users are connected (or the waiting time runs out), a **running** stage that drives your game controller until the game is over (or the running time runs out), and an **end** stage that reports the outcome and drops every remaining connection.

This package decides **when** things happen — a tick, a snapshot, a stage change, the end of the game. **What** reaches the clients, and in what shape, is up to you: every outbound message goes through a hook. Leave the hooks unset and it keeps sending the messages it always has (`{ type: "stage", payload: { stage, age } }` once per second, and `{ type: "enter", payload: { memberId } }` on entrance); set one and it is replaced entirely.

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
  broadcast,
  createGamebaseContext,
  gamebaseOptionsFromEnv,
  handleActor,
  reply,
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
        pollIntervalMillis: 100,
        // Real time: the simulation advances whether or not anyone acts.
        tick: { mode: "fixed", intervalMillis: 50 },
        snapshotIntervalMillis: 100,
        minPlayers: 3,
        isGameOver: ({ context }) =>
          Object.keys(context.connectedUsers).length === 0,
        processMessage: async ({ context, message }) => {
          // Apply a game message to your own state.
        },
        updateTimeDelta: async ({ context, delta }) => {
          // Advance monsters, damage over time, cooldowns.
        },
        onSnapshot: async ({ context }) => {
          // Your own protocol; this package defines no snapshot format.
          await broadcast(
            Object.keys(context.connectedUsers),
            buildSnapshot(),
            {
              context,
            },
          );
        },
        onMemberEntered: async ({ connectionId }) => {
          // Also fires on a reconnect: the place to resynchronize.
          await reply(connectionId, buildSnapshot(), { context });
        },
        onGameEnd: async ({ context, reason }) => {
          // Connections are still open here, so the result still gets out.
          await broadcast(
            Object.keys(context.connectedUsers),
            { type: "result", payload: { reason } },
            { context },
          );
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

## Tick policy

The running stage advances the simulation one of two ways.

```ts
tick: { mode: "perMessage" }                       // default
tick: { mode: "fixed", intervalMillis: 50, maxCatchUpSteps: 5 }
```

- **`perMessage`** calls `updateTimeDelta` once per processed message with
  the wall-clock time since the previous call. Turn-based games want this:
  nothing moves unless somebody acts.
- **`fixed`** accumulates elapsed time and runs whole `intervalMillis`
  steps, whether or not messages arrived, with a constant `delta`. Real-time
  games need it — otherwise monster AI, damage over time, and cooldowns
  freeze while the party stands still and then jump by seconds at once. The
  constant delta also makes the simulation deterministic and replayable.
  Leftover time stays owed instead of drifting; a backlog beyond
  `maxCatchUpSteps` (default 5) is dropped with a `warn`, so a loop that
  cannot keep up stays responsive rather than falling further behind.

`pollIntervalMillis` paces the queue polling; the `fixed` policy ignores it
and paces itself by `intervalMillis`.

## Public API

- `runGameAllTogether` / `RunGameAllTogetherOptions` (type) — the wait → running → end game loop; a drop-in `gameMain` for `handleActor`. Pass `network: { context }` (or an explicit `client` or `transport`) so broadcasts and connection drops reach the clients; `logger` defaults to `nullLogger`.
- `GameStage` — enum `Wait = "wait"`, `Running = "running"`, `End = "end"`
- `GameTickPolicy` (type) — `{ mode: "perMessage" }` or `{ mode: "fixed", intervalMillis, maxCatchUpSteps? }`
- `GameEndReason` (type) — `"cleared" | "timeout" | "notEnoughPlayers" | "error"`, decided by this package and handed to `onGameEnd`
- `GameHooks` (type) — `onStageChanged`, `onMemberEntered`, `onSnapshot`, `onGameEnd`, with `StageChangedOptions`, `MemberEnteredOptions`, `SnapshotOptions`, `GameEndOptions` (types)
- `GameController` (type) — `isGameOver`, `processMessage`, optional `updateTimeDelta`
- `GameMessageBase` (type) — `{ type: string; connectionId: string }`, the constraint for the message type parameter `M`
- `doInStageWait` / `DoInStageWaitOptions` (type) — the wait stage; it ends early only when every user is connected, and otherwise runs the full `gameWaitingSeconds` and then resolves `true` if at least `minPlayers` made it (default: every user)
- `doInStageRunning` / `DoInStageRunningOptions` (type) — the running stage loop
- `broadcastStage` — the default `onStageChanged`; broadcasts `{ type: "stage", payload: { stage, age } }` and reports per-connection delivery
- `broadcastMemberEntered` — the default `onMemberEntered`; broadcasts `{ type: "enter", payload: { memberId } }`
- `createStageAnnouncer` / `StageAnnouncerOptions` (type) — resolves a stage announcement to the caller's hook or the default broadcast
- `pruneUndeliveredUsers` / `PruneUndeliveredUsersOptions` (type) — unbinds the connections a `broadcast` could not reach, so a client that vanished without a `$disconnect` stops holding the game open. Enabled for the default announcement by `dropUndeliveredConnections`; call it yourself from a custom hook
- `processEnterLeave`, `processEnter`, `processLeave` (+ `ProcessEnterLeaveOptions`, `ProcessEnterOptions`, `ProcessLeaveOptions` types) — enter/leave bookkeeping on the base game context

## Behavior changes

- **`updateTimeDelta` moved out of the message loop.** It used to be called
  from inside the per-message loop, so a game with no traffic did not
  simulate at all. It is now driven by the tick policy above; `perMessage`
  reproduces the old cadence.
- **`loopInterval` → `pollIntervalMillis`**, matching the repository's
  `*Millis` naming.
- **Outbound messages moved behind hooks.** The stage and entrance messages
  are unchanged unless `onStageChanged` / `onMemberEntered` is set, in which
  case the hook replaces them rather than adding to them.
- **`BroadcastStageOptions` → `StageChangedOptions`**, and `broadcastStage`
  now resolves with the `RespondResult` of its broadcast.
- **The wait stage can start short-handed** via `minPlayers`; the default is
  still every user. It relaxes the verdict, not the schedule — latecomers
  still get the whole waiting window.

## Migrating from the legacy package

- The npm package was renamed: `@yingyeothon/do-game-all-together` → `@yingyeothon/gamebase-all-together`.
- Options types follow the monorepo `*Options` convention: `RunGameAllTogetherArgs` → `RunGameAllTogetherOptions`, and every exported function's options object now has a named, exported `*Options` type (`DoInStageWaitOptions`, `DoInStageRunningOptions`, `StageChangedOptions`, `ProcessEnterOptions`, `ProcessLeaveOptions`, `ProcessEnterLeaveOptions`). Function names are unchanged.
- `@yingyeothon/lambda-gamebase` no longer keeps module-singleton network clients. Pass `network: { context }` (a `GamebaseContext` from `createGamebaseContext`) or `network: { client }` in `RunGameAllTogetherOptions` — it is threaded to every `broadcast`/`dropConnection` call. Without it, network calls fall back to environment-independent defaults and will fail outside tests.
- Logging: `logger` now defaults to `nullLogger` (previously a debug-level console logger); pass `createConsoleLogger("debug")` from `@yingyeothon/logger` to restore the old behavior. Log calls use the message-first style `logger.info("Game end", { gameId })` instead of the pino-style context-first form.
- All exports are named; there are no default exports. `GameController` moved to a root export (it was a deep import from `services/doInStageRunning` before), and the stage helpers (`doInStageWait`, `doInStageRunning`, `broadcastStage`, `processEnter*`) are now part of the public surface.
- The message type parameter `M` is now constrained by `GameMessageBase` (`{ type: string; connectionId: string }`) instead of `BaseGameRequest`. The legacy constraint made it impossible to type game-specific messages (the whole point of `processMessage`); every legacy-valid `M` still satisfies the new constraint. Runtime dispatch is unchanged: `enter`/`leave` go to enter/leave processing, everything else to `processMessage`.
- See **Behavior changes** above for what moved since the first v2 pass. Note that the underlying `@yingyeothon/lambda-gamebase` moved to AWS SDK v3: a gone WebSocket client now surfaces as `GoneException` instead of a `statusCode === 410` error, but `broadcast`/`dropConnection` still report such connections as undelivered/dropped, so this package's enter/leave and end-of-game processing behaves as before.
