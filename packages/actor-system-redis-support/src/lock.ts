import type { LockAcquire, LockRelease } from "@yingyeothon/actor-system";
import { nullLogger, type LogWriter } from "@yingyeothon/logger";
import {
  redisDel,
  redisSet,
  type RedisConnection,
} from "@yingyeothon/naive-redis";

const lockedValue = "1";

export interface RedisLockOptions {
  connection: RedisConnection;
  keyPrefix?: string;
  logger?: LogWriter;
  /** Lock expiration in milliseconds; a non-positive value means no expiry. */
  lockTimeout?: number;
}

/** A Redis `SET NX`-based per-actor lock for the actor system. */
export class RedisLock implements LockAcquire, LockRelease {
  private readonly connection: RedisConnection;
  private readonly keyPrefix: string;
  private readonly logger: LogWriter;
  private readonly lockTimeout: number;

  constructor({
    connection,
    keyPrefix = "",
    logger = nullLogger,
    lockTimeout = -1,
  }: RedisLockOptions) {
    this.connection = connection;
    this.keyPrefix = keyPrefix;
    this.logger = logger;
    this.lockTimeout = lockTimeout;
  }

  public readonly tryAcquire = async (actorId: string): Promise<boolean> => {
    const redisKey = this.keyPrefix + actorId;
    const success = await redisSet(this.connection, redisKey, lockedValue, {
      expirationMillis: this.lockTimeout > 0 ? this.lockTimeout : undefined,
      onlySet: "nx",
    });
    this.logger.debug("redis-lock", "try-acquire", redisKey, success);
    return success;
  };

  public readonly release = async (actorId: string): Promise<boolean> => {
    const redisKey = this.keyPrefix + actorId;
    await redisDel(this.connection, redisKey);
    this.logger.debug("redis-lock", "release", redisKey);
    return true;
  };
}
