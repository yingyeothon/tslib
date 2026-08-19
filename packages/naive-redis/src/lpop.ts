import type { RedisConnection } from "./connection.js";
import { singleGet } from "./exchange/singleGet.js";

export function redisLpop(
  connection: RedisConnection,
  key: string,
): Promise<string | null> {
  return singleGet(connection, [`LPOP "${key}"`]);
}
