import type { RedisConnection } from "./connection.js";
import { serializeCommand } from "./exchange/serialize.js";
import { singleCount } from "./exchange/singleCount.js";

/**
 * Sets a key's time to live in seconds, replacing any existing one.
 * Resolves false when the key does not exist.
 *
 * Rejects a non-positive or non-finite TTL rather than sending it: Redis
 * reads `EXPIRE key 0` as "delete now", so a caller that computed a zero by
 * accident would silently drop the key and be told it succeeded, while
 * `NaN` reaches the server as a live command with a bogus argument.
 */
export function redisExpire(
  connection: RedisConnection,
  key: string,
  seconds: number,
): Promise<boolean> {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return Promise.reject(
      new Error(`Invalid expiration in seconds: ${String(seconds)}`),
    );
  }
  return singleCount(connection, [
    serializeCommand(["EXPIRE", key, Math.floor(seconds).toString()]),
  ]).then((applied) => applied === 1);
}
