import { expect } from "vitest";
import { redisSadd, redisSmembers, redisSrem } from "../src/index.js";
import { fixture } from "./fixture.js";

fixture("set-simple", async (connection) => {
  const testKey = "naive-redis-set";
  const testValue = ["a", "b", "c", "d", "e"];
  expect(await redisSadd(connection, testKey, ...testValue)).toBe(5);
  expect(await redisSadd(connection, testKey, ...testValue)).toBe(0);
  expect(await redisSrem(connection, testKey, ...testValue)).toBe(5);
  expect(await redisSrem(connection, testKey, ...testValue)).toBe(0);

  expect(await redisSadd(connection, testKey, ...testValue)).toBe(5);
  expect((await redisSmembers(connection, testKey)).sort()).toEqual(
    testValue.sort(),
  );
  expect(await redisSrem(connection, testKey, ...testValue)).toBe(5);
  expect(await redisSmembers(connection, testKey)).toEqual([]);
});
