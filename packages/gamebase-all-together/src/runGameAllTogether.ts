import {
  dropConnection,
  setupBaseGameContext,
  type GameMainOptions,
  type NetworkOptions,
} from "@yingyeothon/lambda-gamebase";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import { GameStage } from "./models/GameStage.js";
import { broadcastStage } from "./services/broadcastStage.js";
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
    loopInterval?: number;
    logger?: Logger;
    /**
     * Network options for broadcasts and connection drops: pass the
     * gamebase context (`{ context }`) or an explicit `client`.
     */
    network?: NetworkOptions;
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
  logger = nullLogger,
  network,
}: RunGameAllTogetherOptions<M>): Promise<void> {
  const context = setupBaseGameContext(members);
  try {
    const allConnected = await doInStageWait({
      context,
      gameWaitingSeconds,
      loopInterval,
      pollMessages,
      logger,
      network,
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
        network,
      });
    }
  } catch (error) {
    logger.error("Error in game loop", { gameId, context, error });
  }
  await broadcastStage({
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
  logger.info("Game end", { gameId, members });
}
