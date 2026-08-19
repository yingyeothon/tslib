import type { RedisConnection } from "./connection.js";
import { singleCount } from "./exchange/singleCount.js";

export function redisLlen(
  connection: RedisConnection,
  key: string,
): Promise<number> {
  return singleCount(connection, [`LLEN "${key}"`]);
}
