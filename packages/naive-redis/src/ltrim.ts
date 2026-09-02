import type { RedisConnection } from "./connection.js";
import { inlineCommand } from "./exchange/inline.js";
import { ok } from "./exchange/ok.js";

export function redisLtrim(
  connection: RedisConnection,
  key: string,
  start: number,
  end = -1,
): Promise<boolean> {
  return ok(connection, [inlineCommand("LTRIM", [key, start, end])]);
}
