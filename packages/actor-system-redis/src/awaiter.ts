import type { AwaiterResolve, AwaiterWait } from "@yingyeothon/actor-system";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import {
  redisGet,
  redisSet,
  type RedisConnection,
} from "@yingyeothon/naive-redis";

const resolvedValue = "1";
const resolvedExpirationMillis = 1000;
const sleepIntervalMillis = 50;

function asRedisKey(
  keyPrefix: string,
  actorId: string,
  messageId: string,
): string {
  return `${keyPrefix}${actorId}/${messageId}`;
}

function sleep(millis: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, millis));
}

export interface RedisAwaiterOptions {
  connection: RedisConnection;
  keyPrefix?: string;
  logger?: Logger;
}

export interface RedisAwaiter extends AwaiterResolve, AwaiterWait {}

/**
 * Creates a Redis-backed awaiter for the actor system: `resolve` marks a
 * message as completed with a short-lived key, and `wait` polls that key
 * until it appears or the timeout elapses.
 */
export function createRedisAwaiter({
  connection,
  keyPrefix = "",
  logger = nullLogger,
}: RedisAwaiterOptions): RedisAwaiter {
  return {
    wait: async (
      actorId: string,
      messageId: string,
      timeoutMillis: number,
    ): Promise<boolean> => {
      logger.debug("redis-awaiter wait", { messageId, timeoutMillis });
      if (timeoutMillis <= 0) {
        return false;
      }

      const redisKey = asRedisKey(keyPrefix, actorId, messageId);
      const start = Date.now();
      let remainMillis = 0;
      do {
        const value = await redisGet(connection, redisKey);
        remainMillis = start + timeoutMillis - Date.now();

        logger.debug("redis-awaiter polled", { redisKey, value, remainMillis });
        if (value === resolvedValue) {
          return true;
        }

        await sleep(Math.max(0, Math.min(sleepIntervalMillis, remainMillis)));
      } while (remainMillis > 0);
      return false;
    },
    resolve: async (actorId: string, messageId: string): Promise<void> => {
      const redisKey = asRedisKey(keyPrefix, actorId, messageId);
      try {
        const success = await redisSet(connection, redisKey, resolvedValue, {
          expirationMillis: resolvedExpirationMillis,
        });
        logger.debug("redis-awaiter resolved", { redisKey, success });
      } catch (error) {
        logger.debug("redis-awaiter resolve failed", { redisKey, error });
      }
    },
  };
}
