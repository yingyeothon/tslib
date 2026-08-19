import { inject, test } from "vitest";
import {
  redisConnect,
  type RedisConfig,
  type RedisConnection,
} from "../src/index.js";

export function redisConfigFromEnv(): RedisConfig {
  return { host: inject("redisHost"), port: inject("redisPort") };
}

export function testbed(
  testName: string,
  testWork: (config: RedisConfig) => Promise<void>,
): void {
  test(testName, async () => {
    await testWork(redisConfigFromEnv());
  });
}

export function fixture(
  testName: string,
  connectionWork: (connection: RedisConnection) => Promise<void>,
): void {
  testbed(testName, async (config) => {
    const connection = redisConnect(config);
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
