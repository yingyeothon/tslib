import {
  eventLoop,
  type ActorEventLoopOptions,
} from "@yingyeothon/actor-system";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import { redisDel, type RedisConnection } from "@yingyeothon/naive-redis";
import type { GameMainOptions } from "../models/GameMainOptions.js";
import type { GameStartMember } from "../models/GameStartMember.js";
import { clearActorStartEvent } from "./clearActorStartEvent.js";

export interface StartActorLoopOptions<M> {
  gameId: string;
  members: GameStartMember[];
  eventKeyPrefix: string;
  logger?: Logger;
  subsystem: Omit<ActorEventLoopOptions<M>, "id" | "loop">;
  redisConnection: RedisConnection;
  gameMain: (args: GameMainOptions<M>) => Promise<unknown>;
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
  subsystem,
  logger = nullLogger,
  eventKeyPrefix,
  redisConnection,
  gameMain,
  deleteStartEvent = (key) => redisDel(redisConnection, key),
}: StartActorLoopOptions<M>): Promise<void> {
  await eventLoop<M>({
    ...subsystem,
    id: gameId,
    loop: async (poll) => {
      // `members` carries names and e-mail addresses.
      logger.info("start a game with id", {
        gameId,
        memberCount: members.length,
      });
      async function pollMessages(): Promise<M[]> {
        const messages = await poll();
        if (messages.length > 0) {
          logger.info("process game messages", {
            actorId: gameId,
            count: messages.length,
          });
        }
        return messages;
      }

      try {
        await gameMain({ gameId, members, pollMessages });
      } catch (error) {
        logger.error("unexpected error from game", { gameId, error });
      }
      logger.info("end of the game", { gameId, memberCount: members.length });
      await clearActorStartEvent({
        gameId,
        del: deleteStartEvent,
        eventKeyPrefix,
      });
    },
  });
}
