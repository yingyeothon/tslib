import {
  sleep,
  Ticker,
  type BaseGameContext,
  type BaseGameRequest,
} from "@yingyeothon/lambda-gamebase";
import type { Logger } from "@yingyeothon/logger";
import { GameStage } from "../models/GameStage.js";
import { broadcastStage } from "./broadcastStage.js";
import type { GameMessageBase } from "./doInStageRunning.js";
import { processEnterLeave } from "./processEnterLeave.js";

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
  logger,
}: {
  context: BaseGameContext;
  gameWaitingSeconds: number;
  loopInterval: number;
  pollMessages: () => Promise<M[]>;
  logger: Logger;
}): Promise<boolean> {
  logger.info({ context }, "Start of wait stage");

  function isAllConnected(): boolean {
    return Object.keys(context.connectedUsers).length === context.users.length;
  }

  const ticker = new Ticker<GameStage>(
    GameStage.Wait,
    gameWaitingSeconds * 1000,
  );
  while (ticker.isAlive() && !isAllConnected()) {
    const messages = await pollMessages();
    for (const message of messages) {
      try {
        await processEnterLeave({
          context,
          message: message as unknown as BaseGameRequest,
        });
      } catch (error) {
        logger.error(
          { context, message, error },
          "Cannot process enter-leave message",
        );
      }
    }

    await ticker.checkAgeChanged((stage, age) =>
      broadcastStage({ context, stage, age }),
    );
    await sleep(loopInterval);
  }

  logger.info({ context }, "End of wait stage");
  return isAllConnected();
}
