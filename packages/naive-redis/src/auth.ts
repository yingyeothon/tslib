import type { RedisConnection } from "./connection.js";
import { ok } from "./exchange/ok.js";
import { serializeCommand } from "./exchange/serialize.js";

export interface RedisAuthOptions {
  /** ACL user name (Redis >= 6). Omitted = the `default` user. */
  username?: string;
}

/**
 * Sends `AUTH`. With `username` it is the two-argument ACL form
 * (`AUTH <username> <password>`), otherwise the legacy `requirepass` form.
 */
export function redisAuth(
  connection: RedisConnection,
  password: string,
  { username }: RedisAuthOptions = {},
): Promise<boolean> {
  const command =
    username !== undefined ? ["AUTH", username, password] : ["AUTH", password];
  return ok(connection, [serializeCommand(command)], {
    urgent: true,
  });
}
