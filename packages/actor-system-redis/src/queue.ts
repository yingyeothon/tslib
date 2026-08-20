import type {
  QueueBulkConsumer,
  QueueLength,
  QueueProducer,
  QueueSingleConsumer,
} from "@yingyeothon/actor-system";
import { jsonCodec, type Codec } from "@yingyeothon/codec";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import {
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
}

export interface RedisQueue
  extends QueueLength, QueueProducer, QueueSingleConsumer, QueueBulkConsumer {}

/** Creates a Redis list-backed message queue for the actor system. */
export function createRedisQueue({
  connection,
  keyPrefix = "",
  codec = jsonCodec,
  logger = nullLogger,
}: RedisQueueOptions): RedisQueue {
  return {
    size: async (actorId: string): Promise<number> => {
      const redisKey = keyPrefix + actorId;
      const length = await redisLlen(connection, redisKey);
      logger.debug("redis-queue size", { redisKey, length });
      return length;
    },
    push: async <T>(actorId: string, item: T): Promise<void> => {
      const redisKey = keyPrefix + actorId;
      const pushed = await redisRpush(connection, redisKey, codec.encode(item));
      logger.debug("redis-queue pushed", { redisKey, item, pushed });
    },
    pop: async <T>(actorId: string): Promise<T | null> => {
      const redisKey = keyPrefix + actorId;
      const value = await redisLpop(connection, redisKey);
      if (value === null) {
        return null;
      }
      const decoded = codec.decode<T>(value);
      logger.debug("redis-queue popped", { redisKey, decoded });
      return decoded;
    },
    peek: async <T>(actorId: string): Promise<T | null> => {
      const redisKey = keyPrefix + actorId;
      const value = await redisLindex(connection, redisKey, 0);
      if (value === null) {
        return null;
      }
      const decoded = codec.decode<T>(value);
      logger.debug("redis-queue peeked", { redisKey, decoded });
      return decoded;
    },
    flush: async <T>(actorId: string): Promise<T[]> => {
      const redisKey = keyPrefix + actorId;
      const values = await redisLrange(connection, redisKey, 0, -1);
      if (values.length === 0) {
        logger.debug("redis-queue flushed empty", { redisKey });
        return [];
      }

      const decoded = values.map((value) => codec.decode<T>(value));
      logger.debug("redis-queue flushed", { redisKey, decoded });

      await redisLtrim(connection, redisKey, values.length, -1);
      return decoded;
    },
  };
}
