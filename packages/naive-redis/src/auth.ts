import type { RedisConnection } from "./connection.js";
import { ok } from "./exchange/ok.js";

export function redisAuth(
  connection: RedisConnection,
  password: string,
): Promise<boolean> {
  return ok(connection, [`AUTH ${password}`], { urgent: true });
}
