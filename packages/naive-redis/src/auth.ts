import type { RedisConnection } from "./connection.js";
import { ok } from "./exchange/ok.js";
import { serializeCommand } from "./exchange/serialize.js";

export function redisAuth(
  connection: RedisConnection,
  password: string,
): Promise<boolean> {
  return ok(connection, [serializeCommand(["AUTH", password])], {
    urgent: true,
  });
}
