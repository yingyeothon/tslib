import type { RedisConnection } from "./connection.js";
import { ensureValue } from "./exchange/ensureValue.js";
import { serializeCommand } from "./exchange/serialize.js";
import { redisSend } from "./send.js";

export interface RedisSetOptions {
  expirationMillis?: number;
  onlySet?: "nx" | "xx";
}

export function redisSet(
  connection: RedisConnection,
  key: string,
  value: string,
  { expirationMillis, onlySet }: RedisSetOptions = {},
): Promise<boolean> {
  const command: string[] = ["SET", key, value];
  if (expirationMillis !== undefined) {
    command.push("PX");
    command.push(expirationMillis.toString());
  }
  if (onlySet !== undefined) {
    command.push(onlySet.toUpperCase());
  }
  return redisSend({
    connection,
    commands: [serializeCommand(command)],
    match: (m) => m.capture("\r\n"),
    transform: (result) => ensureValue(result, 0, /(\+OK|\$-1)/) === "+OK",
  });
}

export { serializeCommand };
