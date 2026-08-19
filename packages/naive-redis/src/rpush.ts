import type { RedisConnection } from "./connection.js";
import { singleCount } from "./exchange/singleCount.js";

export function redisRpush(
  connection: RedisConnection,
  key: string,
  ...values: string[]
): Promise<number> {
  return singleCount(connection, [
    `RPUSH "${key}" ${values.map((value) => JSON.stringify(value)).join(" ")}`,
  ]);
}
