import type { RedisConnection } from "../connection.js";
import { redisSend } from "../send.js";
import { ensureValue } from "./ensureValue.js";

export function ok(
  connection: RedisConnection,
  commands: string[],
  { urgent }: { urgent?: boolean } = {},
): Promise<boolean> {
  return redisSend({
    connection,
    commands,
    match: (m) => m.capture("\r\n"),
    transform: (result) => ensureValue(result, 0, /\+(OK)/) === "OK",
    urgent,
  });
}
