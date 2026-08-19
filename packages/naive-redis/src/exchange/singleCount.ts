import type { RedisConnection } from "../connection.js";
import { redisSend } from "../send.js";
import { ensureValue } from "./ensureValue.js";

export function singleCount(
  connection: RedisConnection,
  commands: string[],
): Promise<number> {
  return redisSend({
    connection,
    commands,
    match: (m) => m.capture("\r\n"),
    transform: (result) => +ensureValue(result, 0, /:([0-9]+)/),
  });
}
