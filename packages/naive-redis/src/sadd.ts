import type { RedisConnection } from "./connection.js";
import { singleCount } from "./exchange/singleCount.js";

export function redisSadd(
  connection: RedisConnection,
  key: string,
  ...values: string[]
): Promise<number> {
  return singleCount(connection, [
    `SADD "${key}" ${values.map((value) => JSON.stringify(value)).join(" ")}`,
  ]);
}
