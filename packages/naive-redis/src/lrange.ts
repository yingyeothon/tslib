import type { RedisConnection } from "./connection.js";
import { inlineCommand } from "./exchange/inline.js";
import { multipleGet } from "./exchange/multipleGet.js";

export function redisLrange(
  connection: RedisConnection,
  key: string,
  start: number,
  end = -1,
): Promise<string[]> {
  return multipleGet(connection, [inlineCommand("LRANGE", [key, start, end])]);
}
