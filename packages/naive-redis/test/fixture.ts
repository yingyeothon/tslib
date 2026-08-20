import { inject, test } from "vitest";
import {
  createRedisConnection,
  type RedisConnectionOptions,
  type RedisConnection,
} from "../src/index.js";

export function redisConnectionOptionsFromEnv(): RedisConnectionOptions {
  return { host: inject("redisHost"), port: inject("redisPort") };
}

export function testbed(
  testName: string,
  testWork: (config: RedisConnectionOptions) => Promise<void>,
): void {
  test(testName, async () => {
    await testWork(redisConnectionOptionsFromEnv());
  });
}

export function fixture(
  testName: string,
  connectionWork: (connection: RedisConnection) => Promise<void>,
): void {
  testbed(testName, async (config) => {
    const connection = createRedisConnection(config);
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
