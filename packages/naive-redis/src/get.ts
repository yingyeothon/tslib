import type { RedisConnection } from "./connection.js";
import { singleGet } from "./exchange/singleGet.js";

export function redisGet(
  connection: RedisConnection,
  key: string,
): Promise<string | null> {
  return singleGet(connection, [`GET "${key}"`]);
}
