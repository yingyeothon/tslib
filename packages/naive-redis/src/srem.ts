import type { RedisConnection } from "./connection.js";
import { singleCount } from "./exchange/singleCount.js";
import { quoteArg } from "./exchange/quote.js";

export function redisSrem(
  connection: RedisConnection,
  key: string,
  ...values: string[]
): Promise<number> {
  return singleCount(connection, [
    `SREM ${quoteArg(key)} ${values.map((value) => JSON.stringify(value)).join(" ")}`,
  ]);
}
