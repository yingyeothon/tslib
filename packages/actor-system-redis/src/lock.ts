import { randomUUID } from "node:crypto";
import type {
  LockAcquire,
  LockRelease,
  LockRenew,
} from "@yingyeothon/actor-system";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import {
  redisEval,
  redisSet,
  type RedisConnection,
} from "@yingyeothon/naive-redis";

// Delete only what this holder wrote. A bare `DEL` deletes whatever is
// there, including the lock a *new* owner took after this one's lease
// expired — and then two actors simulate the same game.
const compareAndDelete =
  'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';

const compareAndExtend =
  'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("PEXPIRE", KEYS[1], ARGV[2]) else return 0 end';

// A lock with no expiry has nothing to extend, but "do we still hold it?"
// is still a real question: the key can be evicted under `maxmemory`, or
// broken by hand. Answering it costs the round trip the other path pays.
const compareOnly =
  'if redis.call("GET", KEYS[1]) == ARGV[1] then return 1 else return 0 end';

export interface RedisLockOptions {
  connection: RedisConnection;
  keyPrefix?: string;
  logger?: Logger;
  /**
   * Lock expiration in milliseconds.
   *
   * Required, and not because a default is hard to pick: a lock that never
   * expires deadlocks its actor forever when the holder crashes, and that
   * must be an explicit choice rather than what you get by saying nothing.
   * A non-positive value is that explicit choice.
   */
  lockTimeout: number;
}

export interface RedisLock extends LockAcquire, LockRelease, LockRenew {}

/**
 * Creates a Redis `SET NX`-based per-actor lock for the actor system.
 *
 * Each acquisition writes a random token as the value and keeps it in
 * process, so `release` and `renew` act only on a lock this holder still
 * owns. A holder that lost its lease — or a fresh process that never
 * acquired — cannot release or extend someone else's.
 *
 * `renew` always asks Redis, including when there is no expiry to extend:
 * "is this still ours" has an answer either way, and a key that was evicted
 * or broken by hand must not keep reporting that it is held.
 */
export function createRedisLock({
  connection,
  keyPrefix = "",
  logger = nullLogger,
  lockTimeout,
}: RedisLockOptions): RedisLock {
  const tokens = new Map<string, string>();

  return {
    tryAcquire: async (actorId: string): Promise<boolean> => {
      const redisKey = keyPrefix + actorId;
      const token = randomUUID();
      const success = await redisSet(connection, redisKey, token, {
        // A fractional millisecond stringifies to "1000.5", which Redis
        // rejects outright.
        ...(lockTimeout > 0
          ? { expirationMillis: Math.floor(lockTimeout) }
          : {}),
        onlySet: "nx",
      });
      if (success) {
        tokens.set(actorId, token);
      }
      logger.debug("redis-lock try-acquire", { redisKey, success });
      return success;
    },
    release: async (actorId: string): Promise<boolean> => {
      const redisKey = keyPrefix + actorId;
      const token = tokens.get(actorId);
      if (token === undefined) {
        logger.debug("redis-lock release without a token", { redisKey });
        return false;
      }
      // The token is dropped only once the command came back: a release
      // that failed on a broken connection has to stay retryable, and
      // forgetting the token would leave the lock held until it expires.
      const deleted = await redisEval(connection, compareAndDelete, {
        keys: [redisKey],
        args: [token],
      });
      tokens.delete(actorId);
      logger.debug("redis-lock released", { redisKey, deleted });
      return deleted === 1;
    },
    renew: async (actorId: string): Promise<boolean> => {
      const redisKey = keyPrefix + actorId;
      const token = tokens.get(actorId);
      if (token === undefined) {
        logger.debug("redis-lock renew without a token", { redisKey });
        return false;
      }
      const extended = await redisEval(
        connection,
        lockTimeout > 0 ? compareAndExtend : compareOnly,
        {
          keys: [redisKey],
          args:
            lockTimeout > 0
              ? [token, Math.floor(lockTimeout).toString()]
              : [token],
          // The lease is what this is racing; it must not queue behind the
          // work the lease protects.
          urgent: true,
        },
      );
      if (extended !== 1) {
        // The lease is gone, so the token is worthless now.
        tokens.delete(actorId);
      }
      logger.debug("redis-lock renewed", { redisKey, extended });
      return extended === 1;
    },
  };
}
