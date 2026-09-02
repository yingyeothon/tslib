import type { RedisConnection } from "./connection.js";
import { inlineCommand } from "./exchange/inline.js";
import { singleCount } from "./exchange/singleCount.js";

export function redisDel(
  connection: RedisConnection,
  ...keys: string[]
): Promise<number> {
  return singleCount(connection, [inlineCommand("DEL", [], keys)]);
}
