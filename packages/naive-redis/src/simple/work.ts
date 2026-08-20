import {
  createRedisConnection,
  type RedisConnectionOptions,
  type RedisConnection,
} from "../connection.js";

export async function redisSimpleWork<R>(
  config: RedisConnectionOptions,
  work: (connection: RedisConnection) => Promise<R>,
): Promise<R> {
  const connection = createRedisConnection(config);
  try {
    return await work(connection);
  } finally {
    connection.socket.disconnect();
  }
}
