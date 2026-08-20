import type { RedisConnection } from "./connection.js";
import { multipleGet } from "./exchange/multipleGet.js";
import { quoteArg } from "./exchange/quote.js";

export function redisLrange(
  connection: RedisConnection,
  key: string,
  start: number,
  end = -1,
): Promise<string[]> {
  return multipleGet(connection, [`LRANGE ${quoteArg(key)} ${start} ${end}`]);
}
