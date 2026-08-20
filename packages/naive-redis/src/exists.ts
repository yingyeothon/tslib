import type { RedisConnection } from "./connection.js";
import { singleCount } from "./exchange/singleCount.js";
import { quoteArg } from "./exchange/quote.js";

export function redisExists(
  connection: RedisConnection,
  ...keys: string[]
): Promise<number> {
  return singleCount(connection, [
    `EXISTS ${keys.map((key) => `${quoteArg(key)}`).join(" ")}`,
  ]);
}
