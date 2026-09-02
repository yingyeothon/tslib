import {
  createRedisConnection,
  type RedisConnection,
} from "@yingyeothon/naive-redis";
import { test } from "vitest";
import {
  redisConnectionOptionsFromEnv,
  withFlushedRedis,
} from "../../../test-support/redis-fixture.js";

export function fixture(
  testName: string,
  connectionWork: (connection: RedisConnection) => Promise<void>,
): void {
  test(testName, () =>
    withFlushedRedis(
      createRedisConnection(redisConnectionOptionsFromEnv()),
      connectionWork,
    ),
  );
}
