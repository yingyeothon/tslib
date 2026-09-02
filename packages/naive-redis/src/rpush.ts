import type { RedisConnection } from "./connection.js";
import { inlineCommand } from "./exchange/inline.js";
import { singleCount } from "./exchange/singleCount.js";

export function redisRpush(
  connection: RedisConnection,
  key: string,
  ...values: string[]
): Promise<number> {
  return singleCount(connection, [inlineCommand("RPUSH", [key], values)]);
}
