import { nullLogger, type LogWriter } from "@yingyeothon/logger";
import type { RedisConnection } from "@yingyeothon/naive-redis";
import { RedisAwaiter } from "./awaiter.js";
import { RedisLock } from "./lock.js";
import { RedisQueue } from "./queue.js";

export interface RedisSubsystemOptions {
  connection: RedisConnection;
  keyPrefix?: string;
  logger?: LogWriter;
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
export function newRedisSubsystem({
  connection,
  keyPrefix = "",
  logger = nullLogger,
}: RedisSubsystemOptions): RedisSubsystem {
  return {
    queue: new RedisQueue({
      connection,
      keyPrefix: keyPrefix + "queue:",
      logger,
    }),
    lock: new RedisLock({ connection, keyPrefix: keyPrefix + "lock:", logger }),
    awaiter: new RedisAwaiter({
      connection,
      keyPrefix: keyPrefix + "awaiter:",
      logger,
    }),
  };
}
