import {
  sleep,
  Ticker,
  TimeDelta,
  type BaseGameContext,
  type BaseGameRequest,
} from "@yingyeothon/lambda-gamebase";
import type { Logger } from "@yingyeothon/logger";
import { GameStage } from "../models/GameStage.js";
import { broadcastStage } from "./broadcastStage.js";
import { processEnterLeave } from "./processEnterLeave.js";

/**
 * A game message: enter/leave requests plus any game-specific requests
 * carrying a `type` and the sender's `connectionId`.
 */
export type GameMessageBase = { type: string; connectionId: string };

export interface GameController<M extends GameMessageBase> {
  isGameOver: ({ context }: { context: BaseGameContext }) => boolean;
  processMessage: ({
    context,
    message,
  }: {
    context: BaseGameContext;
    message: M;
  }) => Promise<unknown>;
  updateTimeDelta?: ({
    context,
    delta,
  }: {
    context: BaseGameContext;
    delta: number;
  }) => Promise<unknown>;
}

/**
 * Running stage: dispatches enter/leave and game messages to the game
 * controller until the game is over or the running time runs out,
 * broadcasting the stage age once per second.
 */
export async function doInStageRunning<M extends GameMessageBase>({
  context,
  gameRunningSeconds,
  loopInterval,
  isGameOver,
  processMessage,
  updateTimeDelta,
  pollMessages,
  logger,
}: {
  context: BaseGameContext;
  gameRunningSeconds: number;
  loopInterval: number;
  pollMessages: () => Promise<M[]>;
  logger: Logger;
} & GameController<M>): Promise<void> {
  logger.info({ context }, "Start of running stage");

  const timeDelta = new TimeDelta();
  const ticker = new Ticker<GameStage>(
    GameStage.Running,
    gameRunningSeconds * 1000,
  );
  while (ticker.isAlive() && !isGameOver({ context })) {
    const messages = await pollMessages();
    for (const message of messages) {
      try {
        if (message.type === "enter" || message.type === "leave") {
          await processEnterLeave({
            context,
            message: message as unknown as BaseGameRequest,
          });
        } else {
          await processMessage({ context, message });
        }
      } catch (error) {
        logger.error({ context, message, error }, "Cannot process message");
      }
      if (updateTimeDelta) {
        const delta = timeDelta.getDelta();
        try {
          await updateTimeDelta({ context, delta });
        } catch (error) {
          logger.error(
            { context, delta, error },
            "Cannot update with time-delta",
          );
        }
      }
    }

    await ticker.checkAgeChanged((stage, age) =>
      broadcastStage({ context, stage, age }),
    );
    await sleep(loopInterval);
  }

  logger.info({ context }, "End of running stage");
}
