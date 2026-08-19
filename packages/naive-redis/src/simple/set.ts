import type { RedisConfig } from "../connection.js";
import { redisSet } from "../set.js";
import { redisSimpleWork } from "./work.js";

export async function redisSimpleSet<T>({
  config,
  key,
  value,
  expirationMillis,
  encode = JSON.stringify,
}: {
  config: RedisConfig;
  key: string;
  value: T;
  expirationMillis?: number;
  encode?: (maybe: T) => string;
}): Promise<boolean> {
  return await redisSimpleWork(config, async (connection) => {
    return await redisSet(connection, key, encode(value), {
      expirationMillis,
    });
  });
}
