import {
  createTicker,
  sleep,
  type BaseGameContext,
  type BaseGameRequest,
  type NetworkOptions,
} from "@yingyeothon/lambda-gamebase";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import { GameStage } from "../models/GameStage.js";
import { broadcastStage } from "./broadcastStage.js";
import type { GameMessageBase } from "./doInStageRunning.js";
import { processEnterLeave } from "./processEnterLeave.js";

export interface DoInStageWaitOptions<M extends GameMessageBase> {
  context: BaseGameContext;
  gameWaitingSeconds: number;
  loopInterval: number;
  pollMessages: () => Promise<M[]>;
  logger?: Logger;
  /** Network options (gamebase context or explicit client) for broadcasts. */
  network?: NetworkOptions;
}

/**
 * Wait stage: processes enter/leave messages until every user is
 * connected or the waiting time runs out, broadcasting the stage age
 * once per second. Messages other than enter/leave are ignored.
 * Returns whether all users connected in time.
 */
export async function doInStageWait<M extends GameMessageBase>({
  context,
  gameWaitingSeconds,
  loopInterval,
  pollMessages,
  logger = nullLogger,
  network,
}: DoInStageWaitOptions<M>): Promise<boolean> {
  logger.info("Start of wait stage", { context });

  function isAllConnected(): boolean {
    return Object.keys(context.connectedUsers).length === context.users.length;
  }

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
        });
      } catch (error) {
        logger.error("Cannot process enter-leave message", {
          context,
          message,
          error,
        });
      }
    }

    await ticker.checkAgeChanged((stage, age) =>
      broadcastStage({ context, stage, age, network }),
    );
    await sleep(loopInterval);
  }

  logger.info("End of wait stage", { context });
  return isAllConnected();
}
