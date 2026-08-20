import type { AwaiterResolve, AwaiterWait } from "@yingyeothon/actor-system";
import { nullLogger, type LogWriter } from "@yingyeothon/logger";
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
  logger?: LogWriter;
}

/**
 * A Redis-backed awaiter for the actor system: `resolve` marks a message
 * as completed with a short-lived key, and `wait` polls that key until it
 * appears or the timeout elapses.
 */
export class RedisAwaiter implements AwaiterResolve, AwaiterWait {
  private readonly connection: RedisConnection;
  private readonly keyPrefix: string;
  private readonly logger: LogWriter;

  constructor({
    connection,
    keyPrefix = "",
    logger = nullLogger,
  }: RedisAwaiterOptions) {
    this.connection = connection;
    this.keyPrefix = keyPrefix;
    this.logger = logger;
  }

  public readonly wait = async (
    actorId: string,
    messageId: string,
    timeoutMillis: number,
  ): Promise<boolean> => {
    this.logger.debug("redis-awaiter", "wait", messageId, timeoutMillis);
    if (timeoutMillis <= 0) {
      return false;
    }

    const redisKey = asRedisKey(this.keyPrefix, actorId, messageId);
    const start = Date.now();
    let remainMillis = 0;
    do {
      const value = await redisGet(this.connection, redisKey);
      remainMillis = start + timeoutMillis - Date.now();

      this.logger.debug("redis-awaiter", "wait", redisKey, value, remainMillis);
      if (value === resolvedValue) {
        return true;
      }

      await sleep(Math.max(0, Math.min(sleepIntervalMillis, remainMillis)));
    } while (remainMillis > 0);
    return false;
  };

  public readonly resolve = async (
    actorId: string,
    messageId: string,
  ): Promise<void> => {
    const redisKey = asRedisKey(this.keyPrefix, actorId, messageId);
    try {
      const success = await redisSet(this.connection, redisKey, resolvedValue, {
        expirationMillis: resolvedExpirationMillis,
      });
      this.logger.debug("redis-awaiter", "resolve", redisKey, success);
    } catch (error) {
      this.logger.debug("redis-awaiter", "resolve", redisKey, "error", error);
    }
  };
}
