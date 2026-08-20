import {
  createTicker,
  createTimeDelta,
  sleep,
  type BaseGameContext,
  type BaseGameRequest,
  type NetworkOptions,
} from "@yingyeothon/lambda-gamebase";
import { nullLogger, type Logger } from "@yingyeothon/logger";
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

export type DoInStageRunningOptions<M extends GameMessageBase> = {
  context: BaseGameContext;
  gameRunningSeconds: number;
  loopInterval: number;
  pollMessages: () => Promise<M[]>;
  logger?: Logger;
  /** Network options (gamebase context or explicit client) for broadcasts. */
  network?: NetworkOptions;
} & GameController<M>;

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
  logger = nullLogger,
  network,
}: DoInStageRunningOptions<M>): Promise<void> {
  logger.info("Start of running stage", { context });

  const timeDelta = createTimeDelta();
  const ticker = createTicker<GameStage>({
    stage: GameStage.Running,
    aliveMillis: gameRunningSeconds * 1000,
  });
  while (ticker.isAlive() && !isGameOver({ context })) {
    const messages = await pollMessages();
    for (const message of messages) {
      try {
        if (message.type === "enter" || message.type === "leave") {
          await processEnterLeave({
            context,
            message: message as unknown as BaseGameRequest,
            network,
          });
        } else {
          await processMessage({ context, message });
        }
      } catch (error) {
        logger.error("Cannot process message", { context, message, error });
      }
      if (updateTimeDelta) {
        const delta = timeDelta.getDelta();
        try {
          await updateTimeDelta({ context, delta });
        } catch (error) {
          logger.error("Cannot update with time-delta", {
            context,
            delta,
            error,
          });
        }
      }
    }

    await ticker.checkAgeChanged((stage, age) =>
      broadcastStage({ context, stage, age, network }),
    );
    await sleep(loopInterval);
  }

  logger.info("End of running stage", { context });
}
