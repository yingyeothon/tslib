import { createHash } from "node:crypto";
import { jsonCodec, type Codec } from "@yingyeothon/codec";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import {
  redisDel,
  redisEval,
  redisGet,
  redisSet,
  type RedisConnection,
} from "@yingyeothon/naive-redis";
import {
  createRepositoryFromKV,
  type CasRepository,
  type CompareAndSetOptions,
  type ExpirableRepository,
} from "@yingyeothon/repository";

export interface RedisRepositoryOptions {
  redisConnection: RedisConnection;
  prefix?: string;
  codec?: Codec<string>;
  logger?: Logger;
}

export interface RedisRepository extends ExpirableRepository, CasRepository {
  withPrefix(prefix: string): RedisRepository;
}

const ttlRequiredMessage =
  "@yingyeothon/repository-redis stores every key with a TTL; use setWithExpire, or pass expiresInMillis to compareAndSet and to the document factories.";

/**
 * Conditional write. Every value travels in ARGV, never in the script text,
 * and the expected token is compared against `redis.sha1hex` of the stored
 * string, which is exactly what `getRevision` hands out.
 */
const compareAndSetScript = `
local cur = redis.call('GET', KEYS[1])
if ARGV[1] == '' then
  if cur then return 0 end
elseif not cur or redis.sha1hex(cur) ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1
`.trim();

function revisionToken(stored: string): string {
  return createHash("sha1").update(stored, "utf8").digest("hex");
}

function assertTtl(
  expiresInMillis: number | undefined,
): asserts expiresInMillis is number {
  if (expiresInMillis === undefined || expiresInMillis <= 0) {
    throw new Error(ttlRequiredMessage);
  }
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

  function asSerialized(stored: string): string {
    return codec === jsonCodec ? stored : JSON.stringify(codec.decode(stored));
  }

  const kvRepository = createRepositoryFromKV({
    async get(key: string): Promise<string | undefined> {
      try {
        const stored = await redisGet(redisConnection, asRedisKey(key));
        if (!stored) {
          return undefined;
        }
        return asSerialized(stored);
      } catch (error) {
        logger.error("failed to read value", { key, error });
        return undefined;
      }
    },
    set(): Promise<void> {
      return Promise.reject(new Error(ttlRequiredMessage));
    },
    async setWithExpire(
      key: string,
      serialized: string,
      expiresInMillis: number,
    ): Promise<void> {
      await redisSet(redisConnection, asRedisKey(key), asStored(serialized), {
        // `PX` takes whole milliseconds.
        expirationMillis: Math.ceil(expiresInMillis),
      });
    },
    async delete(key: string): Promise<void> {
      await redisDel(redisConnection, asRedisKey(key));
    },
    async getRevision(
      key: string,
    ): Promise<{ serialized: string; token: string } | undefined> {
      const stored = await redisGet(redisConnection, asRedisKey(key));
      if (!stored) {
        return undefined;
      }
      return { serialized: asSerialized(stored), token: revisionToken(stored) };
    },
    async compareAndSet(
      key: string,
      expectedToken: string | undefined,
      serialized: string,
      expiresInMillis?: number,
    ): Promise<boolean> {
      assertTtl(expiresInMillis);
      const written = await redisEval(redisConnection, compareAndSetScript, {
        keys: [asRedisKey(key)],
        args: [
          expectedToken ?? "",
          asStored(serialized),
          // `PX` takes whole milliseconds.
          String(Math.ceil(expiresInMillis)),
        ],
      });
      return written === 1;
    },
  });

  return {
    get: (key) => kvRepository.get(key),
    async set<T>(key: string, value: T): Promise<void> {
      if (value === undefined) {
        return kvRepository.delete(key);
      }
      throw new Error(ttlRequiredMessage);
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
    getRevision: (key) => kvRepository.getRevision(key),
    async compareAndSet<T>(
      key: string,
      expectedToken: string | undefined,
      value: T,
      options?: CompareAndSetOptions,
    ): Promise<boolean> {
      if (value === undefined) {
        throw new Error(
          "compareAndSet cannot store undefined; use delete to remove a key.",
        );
      }
      return kvRepository.compareAndSet(key, expectedToken, value, options);
    },
    withPrefix: (newPrefix) =>
      createRedisRepository({ ...options, prefix: newPrefix }),
  };
}
