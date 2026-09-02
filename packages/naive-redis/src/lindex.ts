import type { RedisConnection } from "./connection.js";
import { inlineCommand } from "./exchange/inline.js";
import { singleGet } from "./exchange/singleGet.js";

export function redisLindex(
  connection: RedisConnection,
  key: string,
  pos: number,
): Promise<string | null> {
  return singleGet(connection, [inlineCommand("LINDEX", [key, pos])]);
}
