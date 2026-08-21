import {
  createTicker,
  sleep,
  type BaseGameContext,
  type BaseGameRequest,
  type NetworkOptions,
} from "@yingyeothon/lambda-gamebase";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import { GameStage } from "../models/GameStage.js";
import type { GameHooks } from "../models/hooks.js";
import { createStageAnnouncer } from "./createStageAnnouncer.js";
import { describeGame } from "./describeGame.js";
import type { GameMessageBase } from "./doInStageRunning.js";
import { processEnterLeave } from "./processEnterLeave.js";

export interface DoInStageWaitOptions<M extends GameMessageBase> extends Pick<
  GameHooks,
  "onStageChanged" | "onMemberEntered"
> {
  context: BaseGameContext;
  gameWaitingSeconds: number;
  /** Milliseconds to sleep between queue polls. */
  pollIntervalMillis: number;
  pollMessages: () => Promise<M[]>;
  /**
   * How many users must be connected for the game to start. Defaults to
   * every user, which cancels the whole run when one member is late; a
   * lower value lets the rest play.
   */
  minPlayers?: number;
  /** Unbind connections a stage broadcast could not reach. */
  dropUndeliveredConnections?: boolean;
  logger?: Logger;
  /** Network options (gamebase context or explicit client) for broadcasts. */
  network?: NetworkOptions;
}

/**
 * Wait stage: processes enter/leave messages until every user is
 * connected or the waiting time runs out, announcing the stage age once
 * per second. Messages other than enter/leave are ignored.
 * Returns whether enough users connected to start the game.
 */
export async function doInStageWait<M extends GameMessageBase>({
  context,
  gameWaitingSeconds,
  pollIntervalMillis,
  pollMessages,
  minPlayers,
  dropUndeliveredConnections = false,
  logger = nullLogger,
  network,
  onStageChanged,
  onMemberEntered,
}: DoInStageWaitOptions<M>): Promise<boolean> {
  logger.info("Start of wait stage", describeGame(context));

  const requiredPlayers = minPlayers ?? context.users.length;
  function connectedCount(): number {
    return Object.keys(context.connectedUsers).length;
  }
  function isAllConnected(): boolean {
    return connectedCount() === context.users.length;
  }

  const announce = createStageAnnouncer({
    dropUndeliveredConnections,
    ...(onStageChanged ? { onStageChanged } : {}),
  });
  const ticker = createTicker<GameStage>({
    stage: GameStage.Wait,
    aliveMillis: gameWaitingSeconds * 1000,
  });
  while (ticker.isAlive() && !isAllConnected()) {
    const messages = await pollMessages();
    for (const message of messages) {
      try {
        await processEnterLeave({
          context,
          message: message as unknown as BaseGameRequest,
          network,
          ...(onMemberEntered ? { onMemberEntered } : {}),
        });
      } catch (error) {
        logger.error("Cannot process enter-leave message", {
          ...describeGame(context),
          type: message.type,
          error,
        });
      }
    }

    await ticker.checkAgeChanged((stage, age) =>
      announce({ context, stage, age, network }),
    );
    await sleep(pollIntervalMillis);
  }

  const started = connectedCount() >= requiredPlayers;
  logger.info("End of wait stage", {
    ...describeGame(context),
    requiredPlayers,
    started,
  });
  return started;
}
