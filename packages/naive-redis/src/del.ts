import type { RedisConnection } from "./connection.js";
import { singleCount } from "./exchange/singleCount.js";

export function redisDel(
  connection: RedisConnection,
  ...keys: string[]
): Promise<number> {
  return singleCount(connection, [
    `DEL ${keys.map((key) => `"${key}"`).join(" ")}`,
  ]);
}
