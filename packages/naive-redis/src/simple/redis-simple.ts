import type { RedisConfig } from "../connection.js";
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
  config: RedisConfig;
  encode?: (input: unknown) => string;
  decode?: <T>(input: string) => T;
  keyPrefix?: string;
}

export class RedisSimple {
  private readonly config: RedisConfig;
  private readonly encode: (input: unknown) => string;
  private readonly decode: <T>(input: string) => T;
  private readonly keyPrefix: string;

  constructor({
    config,
    encode = JSON.stringify,
    decode = JSON.parse,
    keyPrefix = "",
  }: RedisSimpleOptions) {
    this.config = config;
    this.encode = encode;
    this.decode = decode;
    this.keyPrefix = keyPrefix;
  }

  public cache = <A extends unknown[], R>(
    fn: RedisSimpleFn<A, R>,
    {
      cacheKey,
      expirationMillis,
    }: Pick<RedisSimpleCacheOptions<A, R>, "cacheKey" | "expirationMillis">,
  ): RedisSimpleCacheFriends<A, R> => {
    return redisSimpleCache<A, R>(fn, {
      config: this.config,
      cacheKey: (...args: A) => this.keyPrefix + cacheKey(...args),
      encode: this.encode,
      decode: this.decode,
      expirationMillis,
    });
  };

  public get = async <T>(key: string): Promise<T | null> => {
    return await redisSimpleGet<T>({
      config: this.config,
      key,
      decode: this.decode,
    });
  };

  public set = async (
    key: string,
    value: unknown,
    expirationMillis?: number,
  ): Promise<boolean> => {
    return await redisSimpleSet({
      config: this.config,
      key,
      value,
      expirationMillis,
      encode: this.encode,
    });
  };

  public del = async (key: string): Promise<number> => {
    return await redisSimpleDel({ config: this.config, key });
  };
}
