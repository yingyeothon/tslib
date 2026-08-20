import { redisConnect, type RedisConnection } from "@yingyeothon/naive-redis";
import { env } from "../env.js";

let sharedConnection: RedisConnection | undefined;

/**
 * Returns the shared Redis connection built from `REDIS_HOST` and
 * `REDIS_PASSWORD`. It is created lazily on first use and then reused,
 * which suits long-running actor Lambdas.
 */
export function getRedisConnection(): RedisConnection {
  sharedConnection ??= redisConnect({
    host: env.redisHost,
    password: env.redisPassword,
  });
  return sharedConnection;
}

/**
 * Replaces the shared connection, e.g. with a fake one in tests. Passing
 * `undefined` resets it so the next call reconnects from env.
 */
export function setRedisConnection(
  connection: RedisConnection | undefined,
): void {
  sharedConnection = connection;
}
