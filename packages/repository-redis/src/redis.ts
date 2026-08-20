import { jsonCodec, type Codec } from "@yingyeothon/codec";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import {
  redisDel,
  redisGet,
  redisSet,
  type RedisConnection,
} from "@yingyeothon/naive-redis";
import {
  createRepositoryFromKV,
  type ExpirableRepository,
} from "@yingyeothon/repository";

export interface RedisRepositoryOptions {
  redisConnection: RedisConnection;
  prefix?: string;
  codec?: Codec<string>;
  logger?: Logger;
}

export interface RedisRepository extends ExpirableRepository {
  withPrefix(prefix: string): RedisRepository;
}

export function createRedisRepository(
  options: RedisRepositoryOptions,
): RedisRepository {
  const { redisConnection, prefix, logger = nullLogger } = options;
  const codec = options.codec ?? jsonCodec;

  function asRedisKey(key: string): string {
    return prefix ? `repo:${prefix}:${key}` : `repo:${key}`;
  }

  function asStored(serialized: string): string {
    return codec === jsonCodec
      ? serialized
      : codec.encode(JSON.parse(serialized));
  }

  const kvRepository = createRepositoryFromKV({
    async get(key: string): Promise<string | undefined> {
      try {
        const stored = await redisGet(redisConnection, asRedisKey(key));
        if (!stored) {
          return undefined;
        }
        return codec === jsonCodec
          ? stored
          : JSON.stringify(codec.decode(stored));
      } catch (error) {
        logger.error("failed to read value", { key, error });
        return undefined;
      }
    },
    async set(key: string, serialized: string): Promise<void> {
      await redisSet(redisConnection, asRedisKey(key), asStored(serialized));
    },
    async setWithExpire(
      key: string,
      serialized: string,
      expiresInMillis: number,
    ): Promise<void> {
      await redisSet(redisConnection, asRedisKey(key), asStored(serialized), {
        expirationMillis: expiresInMillis,
      });
    },
    async delete(key: string): Promise<void> {
      await redisDel(redisConnection, asRedisKey(key));
    },
  });

  return {
    get: (key) => kvRepository.get(key),
    async set<T>(key: string, value: T): Promise<void> {
      if (value === undefined) {
        return kvRepository.delete(key);
      }
      await kvRepository.set(key, value);
    },
    async setWithExpire<T>(
      key: string,
      value: T,
      expiresInMillis: number,
    ): Promise<void> {
      if (value === undefined) {
        return kvRepository.delete(key);
      }
      if (expiresInMillis <= 0) {
        throw new Error('"expiresInMillis" should be greater than 0.');
      }
      await kvRepository.setWithExpire(key, value, expiresInMillis);
    },
    delete: (key) => kvRepository.delete(key),
    withPrefix: (newPrefix) =>
      createRedisRepository({ ...options, prefix: newPrefix }),
  };
}
