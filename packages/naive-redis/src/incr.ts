import type { RedisConnection } from "./connection.js";
import { singleCount } from "./exchange/singleCount.js";
import { quoteArg } from "./exchange/quote.js";

export function redisIncr(
  connection: RedisConnection,
  key: string,
): Promise<number> {
  return singleCount(connection, [`INCR ${quoteArg(key)}`]);
}
