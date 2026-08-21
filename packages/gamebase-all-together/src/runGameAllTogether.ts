import {
  dropConnection,
  setupBaseGameContext,
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
  await announce({
    context,
    age: gameRunningSeconds,
    stage: GameStage.End,
    network,
  });
  await Promise.all(
    Object.keys(context.connectedUsers).map((connectionId) =>
      dropConnection(connectionId, network),
    ),
  );
  // `members` carries names and e-mail addresses; only counts go out.
  logger.info("Game end", { gameId, ...describeGame(context), reason });
}
