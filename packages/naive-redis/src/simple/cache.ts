import type { RedisConfig } from "../connection.js";
import { redisGet } from "../get.js";
import { redisSet } from "../set.js";
import { redisSimpleDel } from "./del.js";
import { redisSimpleGet } from "./get.js";
import { redisSimpleSet } from "./set.js";
import { redisSimpleWork } from "./work.js";

export type RedisSimpleFn<Args extends unknown[], ReturnType> = (
  ...args: Args
) => Promise<ReturnType>;

export type RedisSimpleCacheFriends<
  Args extends unknown[],
  ReturnType,
> = RedisSimpleFn<Args, ReturnType> & {
  refresh: RedisSimpleFn<Args, void>;
  clear: RedisSimpleFn<Args, void>;
  peek: RedisSimpleFn<Args, ReturnType | null>;
  fn: RedisSimpleFn<Args, ReturnType>;
};

export interface RedisSimpleCacheOptions<A extends unknown[], R> {
  config: RedisConfig;
  cacheKey: (...args: A) => string;
  expirationMillis?: number;
  decode?: (input: string) => R;
  encode?: (input: R) => string;
}

export function redisSimpleCache<A extends unknown[], R>(
  fn: RedisSimpleFn<A, R>,
  {
    config,
    cacheKey,
    expirationMillis,
    decode = JSON.parse,
    encode = JSON.stringify,
  }: RedisSimpleCacheOptions<A, R>,
): RedisSimpleCacheFriends<A, R> {
  async function computeIfAbsent(...args: A): Promise<R> {
    const key = cacheKey(...args);
    return await redisSimpleWork(config, async (connection) => {
      const maybe = await redisGet(connection, key);
      if (maybe !== null) {
        return decode(maybe);
      }
      const result = await fn(...args);
      await redisSet(connection, key, encode(result), { expirationMillis });
      return result;
    });
  }

  async function refresh(...args: A): Promise<void> {
    await redisSimpleSet({
      config,
      key: cacheKey(...args),
      value: await fn(...args),
      expirationMillis,
      encode,
    });
  }

  async function clear(...args: A): Promise<void> {
    await redisSimpleDel({ config, key: cacheKey(...args) });
  }

  async function peek(...args: A): Promise<R | null> {
    return await redisSimpleGet({
      config,
      key: cacheKey(...args),
      decode,
    });
  }

  computeIfAbsent.refresh = refresh;
  computeIfAbsent.clear = clear;
  computeIfAbsent.peek = peek;
  computeIfAbsent.fn = fn;
  return computeIfAbsent;
}
