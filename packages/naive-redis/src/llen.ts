import type { RedisConnection } from "./connection.js";
import { singleCount } from "./exchange/singleCount.js";
import { quoteArg } from "./exchange/quote.js";

export function redisLlen(
  connection: RedisConnection,
  key: string,
): Promise<number> {
  return singleCount(connection, [`LLEN ${quoteArg(key)}`]);
}
