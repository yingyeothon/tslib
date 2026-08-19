import {
  redisConnect,
  type RedisConfig,
  type RedisConnection,
} from "../connection.js";

export async function redisSimpleWork<R>(
  config: RedisConfig,
  work: (connection: RedisConnection) => Promise<R>,
): Promise<R> {
  const connection = redisConnect(config);
  try {
    return await work(connection);
  } finally {
    connection.socket.disconnect();
  }
}
