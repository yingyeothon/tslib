import type { RedisConnection } from "./connection.js";
import { inlineCommand } from "./exchange/inline.js";
import { multipleGet } from "./exchange/multipleGet.js";

export function redisSmembers(
  connection: RedisConnection,
  key: string,
): Promise<string[]> {
  return multipleGet(connection, [inlineCommand("SMEMBERS", [key])]);
}
