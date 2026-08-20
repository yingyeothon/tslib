import {
  createRedisConnection,
  type RedisConnection,
  type RedisConnectionOptions,
} from "@yingyeothon/naive-redis";

/**
 * Opens a short-lived Redis connection, runs `work` with it, and always
 * disconnects afterwards. Suited for API handler Lambdas that touch Redis
 * once per invocation.
 */
export async function useRedis<R>(
  work: (connection: RedisConnection) => Promise<R>,
  connectionOptions: RedisConnectionOptions,
): Promise<R> {
  const redisConnection = createRedisConnection(connectionOptions);
  try {
    return await work(redisConnection);
  } finally {
    redisConnection.socket.disconnect();
  }
}
