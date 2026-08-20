import {
  dropConnection,
  setupBaseGameContext,
  type GameMainArguments,
} from "@yingyeothon/lambda-gamebase";
import { ConsoleLogger, type Logger } from "@yingyeothon/logger";
import { GameStage } from "./models/GameStage.js";
import { broadcastStage } from "./services/broadcastStage.js";
import {
  doInStageRunning,
  type GameController,
  type GameMessageBase,
} from "./services/doInStageRunning.js";
import { doInStageWait } from "./services/doInStageWait.js";

export type RunGameAllTogetherArgs<M extends GameMessageBase> =
  GameMainArguments<M> & {
    gameWaitingSeconds: number;
    gameRunningSeconds: number;
    loopInterval?: number;
    logger?: Logger;
  } & GameController<M>;

/**
 * A `gameMain` implementation for games everyone plays together: waits
 * until all users connect, runs the game loop driven by the given
 * controller, then broadcasts the end stage and drops every connection.
 */
export async function runGameAllTogether<M extends GameMessageBase>({
  gameId,
  members,
  pollMessages,
  gameWaitingSeconds,
  gameRunningSeconds,
  isGameOver,
  processMessage,
  updateTimeDelta,
  loopInterval = 0,
  logger = new ConsoleLogger("debug"),
}: RunGameAllTogetherArgs<M>): Promise<void> {
  const context = setupBaseGameContext(members);
  try {
    const allConnected = await doInStageWait({
      context,
      gameWaitingSeconds,
      loopInterval,
      pollMessages,
      logger,
    });
    if (allConnected) {
      await doInStageRunning({
        context,
        gameRunningSeconds,
        loopInterval,
        isGameOver,
        processMessage,
        updateTimeDelta,
        pollMessages,
        logger,
      });
    }
  } catch (error) {
    logger.error({ gameId, context, error }, "Error in game loop");
  }
  await broadcastStage({
    context,
    age: gameRunningSeconds,
    stage: GameStage.End,
  });
  await Promise.all(
    Object.keys(context.connectedUsers).map((connectionId) =>
      dropConnection(connectionId),
    ),
  );
  logger.info({ gameId, members }, "Game end");
}
