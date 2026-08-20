import { JsonCodec, type Codec } from "@yingyeothon/codec";
import {
  redisDel,
  redisGet,
  redisSet,
  type RedisConnection,
} from "@yingyeothon/naive-redis";
import {
  SimpleRepository,
  type ExpirableRepository,
} from "@yingyeothon/repository";

export interface RedisRepositoryArguments {
  redisConnection: RedisConnection;
  prefix?: string;
  codec?: Codec<string>;
}

export class RedisRepository
  extends SimpleRepository
  implements ExpirableRepository
{
  private readonly redisConnection: RedisConnection;
  private readonly prefix: string;
  private readonly codec: Codec<string>;

  constructor({ redisConnection, prefix, codec }: RedisRepositoryArguments) {
    super();
    this.redisConnection = redisConnection;
    this.codec = codec ?? new JsonCodec();
    this.prefix = prefix ?? "";
  }

  public async get<T>(key: string): Promise<T | undefined> {
    try {
      const value = await redisGet(this.redisConnection, this.asRedisKey(key));
      if (!value) {
        return undefined;
      }
      return this.codec.decode<T>(value);
    } catch (error) {
      console.error(error);
      return undefined;
    }
  }

  public async set<T>(key: string, value: T): Promise<void> {
    if (value === undefined) {
      return this.delete(key);
    }
    await redisSet(
      this.redisConnection,
      this.asRedisKey(key),
      this.codec.encode(value),
    );
  }

  public async setWithExpire<T>(
    key: string,
    value: T,
    expiresInMillis: number,
  ): Promise<void> {
    if (value === undefined) {
      return this.delete(key);
    }
    if (expiresInMillis <= 0) {
      throw new Error('"expiresInMillis" should be greater than 0.');
    }
    await redisSet(
      this.redisConnection,
      this.asRedisKey(key),
      this.codec.encode(value),
      {
        expirationMillis: expiresInMillis,
      },
    );
  }

  public async delete(key: string): Promise<void> {
    await redisDel(this.redisConnection, this.asRedisKey(key));
  }

  public withPrefix(prefix: string): RedisRepository {
    return new RedisRepository({
      redisConnection: this.redisConnection,
      prefix,
      codec: this.codec,
    });
  }

  private asRedisKey(key: string): string {
    return this.prefix ? `repo:${this.prefix}:${key}` : `repo:${key}`;
  }
}
