import type { RedisConnection } from "./connection.js";
import { inlineCommand } from "./exchange/inline.js";
import { singleGet } from "./exchange/singleGet.js";

export function redisLpop(
  connection: RedisConnection,
  key: string,
): Promise<string | null> {
  return singleGet(connection, [inlineCommand("LPOP", [key])]);
}
