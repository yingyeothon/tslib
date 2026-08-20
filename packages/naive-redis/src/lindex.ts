import type { RedisConnection } from "./connection.js";
import { singleGet } from "./exchange/singleGet.js";
import { quoteArg } from "./exchange/quote.js";

export function redisLindex(
  connection: RedisConnection,
  key: string,
  pos: number,
): Promise<string | null> {
  return singleGet(connection, [`LINDEX ${quoteArg(key)} ${pos}`]);
}
