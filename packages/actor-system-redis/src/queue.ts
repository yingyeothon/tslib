import type {
  QueueBulkConsumer,
  QueueLength,
  QueueProducer,
  QueueSingleConsumer,
} from "@yingyeothon/actor-system";
import { jsonCodec, type Codec } from "@yingyeothon/codec";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import {
  redisExpire,
  redisLindex,
  redisLlen,
  redisLpop,
  redisLrange,
  redisLtrim,
  redisRpush,
  type RedisConnection,
} from "@yingyeothon/naive-redis";

export interface RedisQueueOptions {
  connection: RedisConnection;
  keyPrefix?: string;
  codec?: Codec<string>;
  logger?: Logger;
  /**
   * Re-applied on every push, so an abandoned queue disappears instead of
   * growing forever behind a consumer that died. Unset means no TTL, and on
   * a shared `allkeys-lru` Redis that means evicting someone else's keys
   * before anyone notices.
   */
  ttlSeconds?: number;
}

export interface RedisQueue
  extends QueueLength, QueueProducer, QueueSingleConsumer, QueueBulkConsumer {}

/** Creates a Redis list-backed message queue for the actor system. */
export function createRedisQueue({
  connection,
  keyPrefix = "",
  codec = jsonCodec,
  logger = nullLogger,
  ttlSeconds,
}: RedisQueueOptions): RedisQueue {
  return {
    size: async (actorId: string): Promise<number> => {
      const redisKey = keyPrefix + actorId;
      const length = await redisLlen(connection, redisKey);
      logger.debug("redis-queue size", { redisKey, length });
      return length;
    },
    push: async <T>(actorId: string, item: T): Promise<number> => {
      const redisKey = keyPrefix + actorId;
      // `RPUSH` answers with the new length, so depth costs nothing here.
      const depth = await redisRpush(connection, redisKey, codec.encode(item));
      if (ttlSeconds !== undefined && ttlSeconds > 0) {
        await redisExpire(connection, redisKey, ttlSeconds);
      }
      // `item` is the caller's payload; log what routed it, not what it says.
      logger.debug("redis-queue pushed", { redisKey, depth });
      return depth;
    },
    pop: async <T>(actorId: string): Promise<T | null> => {
      const redisKey = keyPrefix + actorId;
      const value = await redisLpop(connection, redisKey);
      if (value === null) {
        return null;
      }
      logger.debug("redis-queue popped", { redisKey });
      return codec.decode<T>(value);
    },
    peek: async <T>(actorId: string): Promise<T | null> => {
      const redisKey = keyPrefix + actorId;
      const value = await redisLindex(connection, redisKey, 0);
      if (value === null) {
        return null;
      }
      logger.debug("redis-queue peeked", { redisKey });
      return codec.decode<T>(value);
    },
    flush: async <T>(actorId: string): Promise<T[]> => {
      const redisKey = keyPrefix + actorId;
      const values = await redisLrange(connection, redisKey, 0, -1);
      if (values.length === 0) {
        logger.debug("redis-queue flushed empty", { redisKey });
        return [];
      }

      const decoded = values.map((value) => codec.decode<T>(value));
      logger.debug("redis-queue flushed", { redisKey, count: decoded.length });

      await redisLtrim(connection, redisKey, values.length, -1);
      return decoded;
    },
  };
}
