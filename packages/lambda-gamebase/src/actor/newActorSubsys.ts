import {
  RedisAwaiter,
  RedisLock,
  RedisQueue,
} from "@yingyeothon/actor-system-redis-support";
import type { Logger } from "@yingyeothon/logger";
import type { RedisConnection } from "@yingyeothon/naive-redis";

export interface NewActorSubsysArgs {
  awaiterKeyPrefix: string;
  queueKeyPrefix: string;
  lockKeyPrefix: string;
  lockTimeoutSeconds: number;
  redisConnection: RedisConnection;
  logger: Logger;
}

export interface ActorSubsystem {
  awaiter: RedisAwaiter;
  queue: RedisQueue;
  lock: RedisLock;
  logger: Logger;
}

/**
 * Builds the Redis-backed actor subsystem (queue, lock, awaiter) with
 * separate key prefixes per component, matching the layout the API
 * handlers (`handleConnect`, ...) enqueue into.
 */
export function newActorSubsys({
  awaiterKeyPrefix,
  queueKeyPrefix,
  lockKeyPrefix,
  lockTimeoutSeconds,
  redisConnection,
  logger,
}: NewActorSubsysArgs): ActorSubsystem {
  return {
    awaiter: new RedisAwaiter({
      connection: redisConnection,
      keyPrefix: awaiterKeyPrefix,
      logger,
    }),
    queue: new RedisQueue({
      connection: redisConnection,
      keyPrefix: queueKeyPrefix,
      logger,
    }),
    lock: new RedisLock({
      connection: redisConnection,
      keyPrefix: lockKeyPrefix,
      logger,
      lockTimeout: lockTimeoutSeconds * 1000,
    }),
    logger,
  };
}
