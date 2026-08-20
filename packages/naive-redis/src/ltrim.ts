import type { RedisConnection } from "./connection.js";
import { ok } from "./exchange/ok.js";
import { quoteArg } from "./exchange/quote.js";

export function redisLtrim(
  connection: RedisConnection,
  key: string,
  start: number,
  end = -1,
): Promise<boolean> {
  return ok(connection, [`LTRIM ${quoteArg(key)} ${start} ${end}`]);
}
