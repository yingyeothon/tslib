import { redisConnect, type RedisConnection } from "@yingyeothon/naive-redis";
import { inject, test } from "vitest";
import { RedisRepository } from "../src/index.js";

export function fixture(
  testName: string,
  repositoryWork: (
    repository: RedisRepository,
    connection: RedisConnection,
  ) => Promise<void>,
): void {
  test(testName, async () => {
    const connection = redisConnect({
      host: inject("redisHost"),
      port: inject("redisPort"),
    });
    try {
      await repositoryWork(
        new RedisRepository({ redisConnection: connection }),
        connection,
      );
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
