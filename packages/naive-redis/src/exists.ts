import type { RedisConnection } from "./connection.js";
import { singleCount } from "./exchange/singleCount.js";

export function redisExists(
  connection: RedisConnection,
  ...keys: string[]
): Promise<number> {
  return singleCount(connection, [
    `EXISTS ${keys.map((key) => `"${key}"`).join(" ")}`,
  ]);
}
