import type { RedisConfig } from "../connection.js";
import { redisGet } from "../get.js";
import { redisSimpleWork } from "./work.js";

export async function redisSimpleGet<T>({
  config,
  key,
  decode = JSON.parse,
}: {
  config: RedisConfig;
  key: string;
  decode?: (maybe: string) => T;
}): Promise<T | null> {
  return await redisSimpleWork(config, async (connection) => {
    const maybe = await redisGet(connection, key);
    return maybe ? decode(maybe) : null;
  });
}
