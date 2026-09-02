import {
  createRedisConnection,
  type RedisConnection,
} from "@yingyeothon/naive-redis";
import { test } from "vitest";
import {
  redisConnectionOptionsFromEnv,
  withFlushedRedis,
} from "../../../test-support/redis-fixture.js";
import { createRedisRepository, type RedisRepository } from "../src/index.js";

export function fixture(
  testName: string,
  repositoryWork: (
    repository: RedisRepository,
    connection: RedisConnection,
  ) => Promise<void>,
): void {
  test(testName, () =>
    withFlushedRedis(
      createRedisConnection(redisConnectionOptionsFromEnv()),
      (connection) =>
        repositoryWork(
          createRedisRepository({ redisConnection: connection }),
          connection,
        ),
    ),
  );
}
