import type { RedisConnectionOptions } from "../connection.js";
import {
  redisSimpleCache,
  type RedisSimpleCacheFriends,
  type RedisSimpleCacheOptions,
  type RedisSimpleFn,
} from "./cache.js";
import { redisSimpleDel } from "./del.js";
import { redisSimpleGet } from "./get.js";
import { redisSimpleSet } from "./set.js";

export interface RedisSimpleOptions {
  config: RedisConnectionOptions;
  encode?: (input: unknown) => string;
  decode?: <T>(input: string) => T;
  keyPrefix?: string;
}

export interface RedisSimple {
  cache: <A extends unknown[], R>(
    fn: RedisSimpleFn<A, R>,
    options: Pick<
      RedisSimpleCacheOptions<A, R>,
      "cacheKey" | "expirationMillis"
    >,
  ) => RedisSimpleCacheFriends<A, R>;
  get: <T>(key: string) => Promise<T | null>;
  set: (
    key: string,
    value: unknown,
    expirationMillis?: number,
  ) => Promise<boolean>;
  del: (key: string) => Promise<number>;
}

export function createRedisSimple({
  config,
  encode = JSON.stringify,
  decode = JSON.parse,
  keyPrefix = "",
}: RedisSimpleOptions): RedisSimple {
  return {
    cache: <A extends unknown[], R>(
      fn: RedisSimpleFn<A, R>,
      {
        cacheKey,
        expirationMillis,
      }: Pick<RedisSimpleCacheOptions<A, R>, "cacheKey" | "expirationMillis">,
    ): RedisSimpleCacheFriends<A, R> =>
      redisSimpleCache<A, R>(fn, {
        config,
        cacheKey: (...args: A) => keyPrefix + cacheKey(...args),
        encode,
        decode,
        expirationMillis,
      }),
    get: async <T>(key: string): Promise<T | null> =>
      await redisSimpleGet<T>({ config, key, decode }),
    set: async (
      key: string,
      value: unknown,
      expirationMillis?: number,
    ): Promise<boolean> =>
      await redisSimpleSet({ config, key, value, expirationMillis, encode }),
    del: async (key: string): Promise<number> =>
      await redisSimpleDel({ config, key }),
  };
}
