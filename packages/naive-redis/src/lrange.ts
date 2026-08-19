import type { RedisConnection } from "./connection.js";
import { multipleGet } from "./exchange/multipleGet.js";

export function redisLrange(
  connection: RedisConnection,
  key: string,
  start: number,
  end = -1,
): Promise<string[]> {
  return multipleGet(connection, [`LRANGE "${key}" ${start} ${end}`]);
}
