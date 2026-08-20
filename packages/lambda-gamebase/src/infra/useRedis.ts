import { redisConnect, type RedisConnection } from "@yingyeothon/naive-redis";
import { env } from "../env.js";

/**
 * Opens a short-lived Redis connection, runs `work` with it, and always
 * disconnects afterwards. Suited for API handler Lambdas that touch Redis
 * once per invocation.
 */
export async function useRedis<R>(
  work: (connection: RedisConnection) => Promise<R>,
  {
    host = env.redisHost,
    password = env.redisPassword,
  }: { host?: string; password?: string } = {},
): Promise<R> {
  const redisConnection = redisConnect({ host, password });
  try {
    return await work(redisConnection);
  } finally {
    redisConnection.socket.disconnect();
  }
}
