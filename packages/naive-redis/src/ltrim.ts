import type { RedisConnection } from "./connection.js";
import { ok } from "./exchange/ok.js";

export function redisLtrim(
  connection: RedisConnection,
  key: string,
  start: number,
  end = -1,
): Promise<boolean> {
  return ok(connection, [`LTRIM "${key}" ${start} ${end}`]);
}
