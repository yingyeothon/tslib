import type { RedisConnection } from "./connection.js";
import { singleGet } from "./exchange/singleGet.js";
import { quoteArg } from "./exchange/quote.js";

export function redisGet(
  connection: RedisConnection,
  key: string,
): Promise<string | null> {
  return singleGet(connection, [`GET ${quoteArg(key)}`]);
}
