import {
  dropConnection,
  setupBaseGameContext,
  sleep,
  type GameMainOptions,
  type NetworkOptions,
} from "@yingyeothon/lambda-gamebase";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import { GameStage } from "./models/GameStage.js";
import type { GameEndReason, GameTickPolicy } from "./models/GameTickPolicy.js";
import type { GameHooks } from "./models/hooks.js";
import { createStageAnnouncer } from "./services/createStageAnnouncer.js";
import { describeGame } from "./services/describeGame.js";
import {
  doInStageRunning,
  type GameController,
  type GameMessageBase,
} from "./services/doInStageRunning.js";
import { doInStageWait } from "./services/doInStageWait.js";

const defaultEndDropDelayMillis = 1000;
const defaultEndRepeatIntervalMillis = 200;

export type RunGameAllTogetherOptions<M extends GameMessageBase> =
  GameMainOptions<M> & {
    gameWaitingSeconds: number;
    gameRunningSeconds: number;
    /** Milliseconds to sleep between queue polls. */
    pollIntervalMillis: number;
    /** How the running stage advances. Defaults to `{ mode: "perMessage" }`. */
    tick?: GameTickPolicy;
    /**
     * Minimum gap between `onSnapshot` calls; unset means never. Snapshots
     * are rate-limited rather than scheduled, so a slow pass delays the
     * next one instead of queueing a burst.
     */
    snapshotIntervalMillis?: number;
    /**
     * How many users must be connected for the game to start. Default: all.
     * It relaxes the verdict, not the schedule — the wait stage still runs
     * for the full `gameWaitingSeconds` unless everyone connects.
     */
    minPlayers?: number;
    /**
     * Unbind connections a stage broadcast could not reach. Only the
     * default announcement reports delivery, so this does nothing once
     * `onStageChanged` is set; call `pruneUndeliveredUsers` from the hook
     * instead.
     */
    dropUndeliveredConnections?: boolean;
    /**
     * Milliseconds between the end-stage announcement and dropping the
     * connections. API Gateway can lose a frame posted right before
     * `DeleteConnection`, which would swallow the result and the end stage;
     * the pause lets them flush. Default 1000; `0` drops immediately.
     */
    endDropDelayMillis?: number;
    /**
     * How many times the end stage is announced and the connections
     * dropped. Default 1.
     *
     * A transport that publishes to a gateway sends these exactly once, and
     * pub/sub has no redelivery: a subscriber gap swallows the end frame
     * (the party is shown no result) or the drop (the sockets stay open
     * forever). Unlike a tick snapshot, nothing later heals either. Set it
     * to 2 or more with `createRedisPubSubTransport`; both operations are
     * idempotent, so the repeats cost a frame each and nothing else.
     *
     * Leave it at 1 for the API Gateway transport, where a repeat is a
     * `PostToConnection` per player against an already-closed connection.
     */
    endRepeatCount?: number;
    /**
     * Gap between repeats. A burst with no gap would be swallowed by the
     * same subscriber outage that swallowed the first frame. Default 200;
     * only used when `endRepeatCount` is above 1.
     */
    endRepeatIntervalMillis?: number;
    logger?: Logger;
    /**
     * Network options for broadcasts and connection drops: pass the
     * gamebase context (`{ context }`), an explicit `client`, or your own
     * `transport`.
     */
    network?: NetworkOptions;
  } & GameController<M> &
    GameHooks;

/**
 * A `gameMain` implementation for games everyone plays together: waits
 * until enough users connect, runs the game loop driven by the given
 * controller, then reports the outcome, announces the end stage, and drops
 * every connection.
 */
export async function runGameAllTogether<M extends GameMessageBase>({
  gameId,
  members,
  pollMessages,
  gameWaitingSeconds,
  gameRunningSeconds,
  pollIntervalMillis,
  tick,
  snapshotIntervalMillis,
  minPlayers,
  dropUndeliveredConnections,
  endDropDelayMillis = defaultEndDropDelayMillis,
  endRepeatCount = 1,
  endRepeatIntervalMillis = defaultEndRepeatIntervalMillis,
  isGameOver,
  processMessage,
  updateTimeDelta,
  logger = nullLogger,
  network,
  onStageChanged,
  onMemberEntered,
  onSnapshot,
  onGameEnd,
}: RunGameAllTogetherOptions<M>): Promise<void> {
  const context = setupBaseGameContext(members);
  const stageOptions = {
    context,
    pollIntervalMillis,
    pollMessages,
    logger,
    network,
    ...(dropUndeliveredConnections === undefined
      ? {}
      : { dropUndeliveredConnections }),
    ...(onStageChanged ? { onStageChanged } : {}),
    ...(onMemberEntered ? { onMemberEntered } : {}),
  };

  let reason: GameEndReason = "timeout";
  try {
    const enoughPlayers = await doInStageWait<M>({
      ...stageOptions,
      gameWaitingSeconds,
      ...(minPlayers === undefined ? {} : { minPlayers }),
    });
    if (enoughPlayers) {
      await doInStageRunning<M>({
        ...stageOptions,
        gameRunningSeconds,
        isGameOver,
        processMessage,
        ...(tick ? { tick } : {}),
        ...(snapshotIntervalMillis === undefined
          ? {}
          : { snapshotIntervalMillis }),
        ...(updateTimeDelta ? { updateTimeDelta } : {}),
        ...(onSnapshot ? { onSnapshot } : {}),
      });
      reason = isGameOver({ context }) ? "cleared" : "timeout";
    } else {
      reason = "notEnoughPlayers";
    }
  } catch (error) {
    reason = "error";
    logger.error("Error in game loop", {
      gameId,
      ...describeGame(context),
      error,
    });
  }

  // The game speaks first: connections are still open here, so a result
  // payload can still reach the clients.
  if (onGameEnd) {
    try {
      await onGameEnd({ context, reason, network });
    } catch (error) {
      logger.error("Cannot report the game result", { gameId, error });
    }
  }

  const announce = createStageAnnouncer({
    ...(dropUndeliveredConnections === undefined
      ? {}
      : { dropUndeliveredConnections }),
    ...(onStageChanged ? { onStageChanged } : {}),
  });
  // Announce, then drop — repeating each in place rather than repeating the
  // pair. A second announcement after the first drop would be addressed to
  // sockets that are already closed, which is the half of the loss the
  // repeat exists to cover.
  const repeats = Math.max(1, Math.floor(endRepeatCount));
  await repeatWithInterval(repeats, endRepeatIntervalMillis, () =>
    announce({
      context,
      age: gameRunningSeconds,
      stage: GameStage.End,
      network,
    }),
  );
  if (endDropDelayMillis > 0) {
    await sleep(endDropDelayMillis);
  }
  // Captured here, after the announcements, so a hook that prunes
  // undelivered users is still reflected exactly as it was before repeats
  // existed.
  const endingConnections = Object.keys(context.connectedUsers);
  await repeatWithInterval(repeats, endRepeatIntervalMillis, () =>
    Promise.all(
      endingConnections.map((connectionId) =>
        dropConnection(connectionId, network),
      ),
    ),
  );
  // `members` carries names and e-mail addresses; only counts go out.
  logger.info("Game end", { gameId, ...describeGame(context), reason });
}

/** Runs `work` `times` times, sleeping `intervalMillis` between runs. */
async function repeatWithInterval(
  times: number,
  intervalMillis: number,
  work: () => Promise<unknown>,
): Promise<void> {
  for (let attempt = 0; attempt < times; attempt++) {
    if (attempt > 0) {
      await sleep(intervalMillis);
    }
    await work();
  }
}
