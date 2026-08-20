import type { RedisConnectionOptions } from "../connection.js";
import { redisDel } from "../del.js";
import { redisSimpleWork } from "./work.js";

export async function redisSimpleDel({
  config,
  key,
}: {
  config: RedisConnectionOptions;
  key: string;
}): Promise<number> {
  return await redisSimpleWork(config, async (connection) => {
    return await redisDel(connection, key);
  });
}
