import type { RedisConnection } from "./connection.js";
import { multipleGet } from "./exchange/multipleGet.js";

export function redisSmembers(
  connection: RedisConnection,
  key: string,
): Promise<string[]> {
  return multipleGet(connection, [`SMEMBERS "${key}"`]);
}
