import {
  eventLoop,
  type ActorEventLoopEnvironment,
} from "@yingyeothon/actor-system";
import type { Logger } from "@yingyeothon/logger";
import { redisDel, type RedisConnection } from "@yingyeothon/naive-redis";
import type { GameMainArguments } from "../models/GameMainArguments.js";
import type { GameStartMember } from "../models/GameStartMember.js";
import { clearActorStartEvent } from "./clearActorStartEvent.js";

export interface StartActorLoopArgs<M> {
  gameId: string;
  members: GameStartMember[];
  eventKeyPrefix: string;
  logger: Logger;
  subsys: Omit<ActorEventLoopEnvironment<M>, "id" | "loop">;
  redisConnection: RedisConnection;
  gameMain: (args: GameMainArguments<M>) => Promise<unknown>;
  /**
   * Deletes the persisted start event when the game ends. Defaults to
   * `redisDel` on `redisConnection`; override it in tests to avoid Redis.
   */
  deleteStartEvent?: (key: string) => Promise<unknown>;
}

/**
 * Runs the game as an actor event loop: acquires the actor lock, calls
 * `gameMain` with a `pollMessages` function draining the queue, and clears
 * the persisted start event when the game ends.
 */
export async function startActorLoop<M>({
  gameId,
  members,
  subsys,
  logger,
  eventKeyPrefix,
  redisConnection,
  gameMain,
  deleteStartEvent = (key) => redisDel(redisConnection, key),
}: StartActorLoopArgs<M>): Promise<void> {
  await eventLoop<M>({
    ...subsys,
    id: gameId,
    loop: async (poll) => {
      logger.info({ gameId, members }, "Start a game with id");
      async function pollMessages(): Promise<M[]> {
        const messages = await poll();
        if (messages.length > 0) {
          logger.info({ messages }, "Process game messages");
        }
        return messages;
      }

      try {
        await gameMain({ gameId, members, pollMessages });
      } catch (error) {
        logger.error({ gameId, error }, "Unexpected error from game");
      }
      logger.info({ gameId, members }, "End of the game");
      await clearActorStartEvent({
        gameId,
        del: deleteStartEvent,
        eventKeyPrefix,
      });
    },
  });
}
