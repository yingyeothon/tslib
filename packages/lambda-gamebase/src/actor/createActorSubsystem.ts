import {
  createRedisAwaiter,
  createRedisLock,
  createRedisQueue,
  type RedisAwaiter,
  type RedisLock,
  type RedisQueue,
} from "@yingyeothon/actor-system-redis";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import type { RedisConnection } from "@yingyeothon/naive-redis";

export interface ActorSubsystemOptions {
  awaiterKeyPrefix: string;
  queueKeyPrefix: string;
  lockKeyPrefix: string;
  lockTimeoutSeconds: number;
  redisConnection: RedisConnection;
  logger?: Logger;
}

export interface ActorSubsystem {
  awaiter: RedisAwaiter;
  queue: RedisQueue;
  lock: RedisLock;
  logger: Logger;
}

/**
 * Creates the Redis-backed actor subsystem (queue, lock, awaiter) with
 * separate key prefixes per component, matching the layout the API
 * handlers (`handleConnect`, ...) enqueue into.
 */
export function createActorSubsystem({
  awaiterKeyPrefix,
  queueKeyPrefix,
  lockKeyPrefix,
  lockTimeoutSeconds,
  redisConnection,
  logger = nullLogger,
}: ActorSubsystemOptions): ActorSubsystem {
  return {
    awaiter: createRedisAwaiter({
      connection: redisConnection,
      keyPrefix: awaiterKeyPrefix,
      logger,
    }),
    queue: createRedisQueue({
      connection: redisConnection,
      keyPrefix: queueKeyPrefix,
      logger,
    }),
    lock: createRedisLock({
      connection: redisConnection,
      keyPrefix: lockKeyPrefix,
      logger,
      lockTimeout: lockTimeoutSeconds * 1000,
    }),
    logger,
  };
}
