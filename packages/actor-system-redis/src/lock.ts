import type { LockAcquire, LockRelease } from "@yingyeothon/actor-system";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import {
  redisDel,
  redisSet,
  type RedisConnection,
} from "@yingyeothon/naive-redis";

const lockedValue = "1";

export interface RedisLockOptions {
  connection: RedisConnection;
  keyPrefix?: string;
  logger?: Logger;
  /** Lock expiration in milliseconds; a non-positive value means no expiry. */
  lockTimeout?: number;
}

export interface RedisLock extends LockAcquire, LockRelease {}

/** Creates a Redis `SET NX`-based per-actor lock for the actor system. */
export function createRedisLock({
  connection,
  keyPrefix = "",
  logger = nullLogger,
  lockTimeout = -1,
}: RedisLockOptions): RedisLock {
  return {
    tryAcquire: async (actorId: string): Promise<boolean> => {
      const redisKey = keyPrefix + actorId;
      const success = await redisSet(connection, redisKey, lockedValue, {
        expirationMillis: lockTimeout > 0 ? lockTimeout : undefined,
        onlySet: "nx",
      });
      logger.debug("redis-lock try-acquire", { redisKey, success });
      return success;
    },
    release: async (actorId: string): Promise<boolean> => {
      const redisKey = keyPrefix + actorId;
      await redisDel(connection, redisKey);
      logger.debug("redis-lock released", { redisKey });
      return true;
    },
  };
}
