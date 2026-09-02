import { test } from "vitest";
import {
  redisConnectionOptionsFromEnv as sharedOptionsFromEnv,
  withFlushedRedis,
} from "../../../test-support/redis-fixture.js";
import {
  createRedisConnection,
  type RedisConnectionOptions,
  type RedisConnection,
} from "../src/index.js";

export function redisConnectionOptionsFromEnv(): RedisConnectionOptions {
  return sharedOptionsFromEnv();
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
  testbed(testName, (config) =>
    withFlushedRedis(createRedisConnection(config), connectionWork),
  );
}
