import type { RedisConnection } from "./connection.js";
import { inlineCommand } from "./exchange/inline.js";
import { singleCount } from "./exchange/singleCount.js";

export function redisLlen(
  connection: RedisConnection,
  key: string,
): Promise<number> {
  return singleCount(connection, [inlineCommand("LLEN", [key])]);
}
