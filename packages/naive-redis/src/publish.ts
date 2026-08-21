import type { RedisConnection } from "./connection.js";
import { serializeCommand } from "./exchange/serialize.js";
import { singleCount } from "./exchange/singleCount.js";

/**
 * Publishes a message to a channel and resolves with the number of
 * subscribers that received it.
 */
export function redisPublish(
  connection: RedisConnection,
  channel: string,
  message: string,
): Promise<number> {
  return singleCount(connection, [
    serializeCommand(["PUBLISH", channel, message]),
  ]);
}
