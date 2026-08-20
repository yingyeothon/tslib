import {
  createRedisConnection,
  type RedisConnection,
} from "@yingyeothon/naive-redis";
import { inject, test } from "vitest";

export function fixture(
  testName: string,
  connectionWork: (connection: RedisConnection) => Promise<void>,
): void {
  test(testName, async () => {
    const connection = createRedisConnection({
      host: inject("redisHost"),
      port: inject("redisPort"),
    });
    try {
      await connectionWork(connection);
    } finally {
      // Clear all entries after the test.
      await connection.socket.send({
        message: "FLUSHALL\r\n",
        fulfill: "+OK\r\n".length,
        timeoutMillis: 1000,
      });
      connection.socket.disconnect();
    }
  });
}
