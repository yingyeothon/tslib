import { nullLogger, type Logger } from "@yingyeothon/logger";
import type { RedisConnection } from "@yingyeothon/naive-redis";
import { createRedisAwaiter, type RedisAwaiter } from "./awaiter.js";
import { createRedisLock, type RedisLock } from "./lock.js";
import { createRedisQueue, type RedisQueue } from "./queue.js";

export interface RedisSubsystemOptions {
  connection: RedisConnection;
  keyPrefix?: string;
  logger?: Logger;
  /** Lock expiration in milliseconds; see `RedisLockOptions.lockTimeout`. */
  lockTimeout: number;
  /** Queue key TTL in seconds; see `RedisQueueOptions.ttlSeconds`. */
  queueTtlSeconds?: number;
}

export interface RedisSubsystem {
  queue: RedisQueue;
  lock: RedisLock;
  awaiter: RedisAwaiter;
}

/**
 * Creates the full Redis-backed actor subsystem (queue, lock, and awaiter)
 * sharing one connection, with `queue:`, `lock:`, and `awaiter:` appended
 * to the given key prefix respectively.
 */
export function createRedisSubsystem({
  connection,
  keyPrefix = "",
  logger = nullLogger,
  lockTimeout,
  queueTtlSeconds,
}: RedisSubsystemOptions): RedisSubsystem {
  return {
    queue: createRedisQueue({
      connection,
      keyPrefix: keyPrefix + "queue:",
      logger,
      ...(queueTtlSeconds !== undefined ? { ttlSeconds: queueTtlSeconds } : {}),
    }),
    lock: createRedisLock({
      connection,
      keyPrefix: keyPrefix + "lock:",
      logger,
      lockTimeout,
    }),
    awaiter: createRedisAwaiter({
      connection,
      keyPrefix: keyPrefix + "awaiter:",
      logger,
    }),
  };
}
