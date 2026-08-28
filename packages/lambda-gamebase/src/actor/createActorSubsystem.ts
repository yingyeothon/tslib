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
  /**
   * Queue key TTL in seconds, applied on every push. Required: every
   * runtime key carries a TTL. The actor only drains its queue, so this
   * matters solely when the same subsystem is used to push — the producers
   * (`handleConnect`, `handleDisconnect`, `handleMessages`, or a gateway)
   * are what normally set it.
   */
  queueTtlSeconds: number;
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
  queueTtlSeconds,
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
      ttlSeconds: queueTtlSeconds,
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
