import type {
  QueueBulkConsumer,
  QueueLength,
  QueueProducer,
  QueueSingleConsumer,
} from "@yingyeothon/actor-system";
import { JsonCodec, type Codec } from "@yingyeothon/codec";
import { nullLogger, type LogWriter } from "@yingyeothon/logger";
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
  logger?: LogWriter;
}

/** A Redis list-backed message queue for the actor system. */
export class RedisQueue
  implements QueueLength, QueueProducer, QueueSingleConsumer, QueueBulkConsumer
{
  private readonly connection: RedisConnection;
  private readonly keyPrefix: string;
  private readonly codec: Codec<string>;
  private readonly logger: LogWriter;

  constructor({
    connection,
    keyPrefix = "",
    codec = new JsonCodec(),
    logger = nullLogger,
  }: RedisQueueOptions) {
    this.connection = connection;
    this.keyPrefix = keyPrefix;
    this.codec = codec;
    this.logger = logger;
  }

  public readonly size = async (actorId: string): Promise<number> => {
    const redisKey = this.keyPrefix + actorId;
    const length = await redisLlen(this.connection, redisKey);
    this.logger.debug("redis-queue", "size", redisKey, length);
    return length;
  };

  public readonly push = async <T>(actorId: string, item: T): Promise<void> => {
    const redisKey = this.keyPrefix + actorId;
    const pushed = await redisRpush(
      this.connection,
      redisKey,
      this.codec.encode(item),
    );
    this.logger.debug("redis-queue", "push", redisKey, item, pushed);
  };

  public readonly pop = async <T>(actorId: string): Promise<T | null> => {
    const redisKey = this.keyPrefix + actorId;
    const value = await redisLpop(this.connection, redisKey);
    if (value === null) {
      return null;
    }
    const decoded = this.codec.decode<T>(value);
    this.logger.debug("redis-queue", "pop", redisKey, decoded);
    return decoded;
  };

  public readonly peek = async <T>(actorId: string): Promise<T | null> => {
    const redisKey = this.keyPrefix + actorId;
    const value = await redisLindex(this.connection, redisKey, 0);
    if (value === null) {
      return null;
    }
    const decoded = this.codec.decode<T>(value);
    this.logger.debug("redis-queue", "peek", redisKey, decoded);
    return decoded;
  };

  public readonly flush = async <T>(actorId: string): Promise<T[]> => {
    const redisKey = this.keyPrefix + actorId;
    const values = await redisLrange(this.connection, redisKey, 0, -1);
    if (values.length === 0) {
      this.logger.debug("redis-queue", "flush", redisKey, "empty");
      return [];
    }

    const decoded = values.map((value) => this.codec.decode<T>(value));
    this.logger.debug("redis-queue", "flush", redisKey, decoded);

    await redisLtrim(this.connection, redisKey, values.length, -1);
    return decoded;
  };
}
