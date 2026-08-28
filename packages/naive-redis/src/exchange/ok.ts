import type { RedisConnection } from "../connection.js";
import { redisSend, type RedisSendOptions } from "../send.js";
import { ensureValue } from "./ensureValue.js";

export function ok(
  connection: RedisConnection,
  commands: string[],
  {
    urgent,
    timeoutMillis,
    recoverAuthentication,
  }: Pick<
    RedisSendOptions<boolean>,
    "urgent" | "timeoutMillis" | "recoverAuthentication"
  > = {},
): Promise<boolean> {
  return redisSend({
    connection,
    commands,
    match: (m) => m.capture("\r\n"),
    transform: (result) => ensureValue(result, 0, /\+(OK)/) === "OK",
    urgent,
    timeoutMillis,
    recoverAuthentication,
  });
}
