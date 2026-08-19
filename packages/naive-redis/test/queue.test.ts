import { expect } from "vitest";
import {
  redisLindex,
  redisLlen,
  redisLpop,
  redisLrange,
  redisLtrim,
  redisRpush,
} from "../src/index.js";
import { fixture } from "./fixture.js";

fixture("simple-push-pop", async (connection) => {
  const testKey = "naive-redis-queue";
  const testValue = (index: number) =>
    JSON.stringify({ hello: "world", index });

  expect(await redisLlen(connection, testKey)).toBe(0);
  expect(await redisLpop(connection, testKey)).toBeNull();
  expect(await redisLindex(connection, testKey, 0)).toBeNull();

  expect(await redisRpush(connection, testKey, testValue(0))).toBe(1);
  expect(await redisLlen(connection, testKey)).toBe(1);

  expect(await redisRpush(connection, testKey, testValue(1))).toBe(2);
  expect(await redisLlen(connection, testKey)).toBe(2);

  expect(await redisLindex(connection, testKey, 0)).toEqual(testValue(0));
  expect(await redisLindex(connection, testKey, 1)).toEqual(testValue(1));

  expect(await redisLpop(connection, testKey)).toEqual(testValue(0));
  expect(await redisLlen(connection, testKey)).toBe(1);
  expect(await redisLindex(connection, testKey, 0)).toEqual(testValue(1));

  expect(await redisLpop(connection, testKey)).toEqual(testValue(1));
  expect(await redisLlen(connection, testKey)).toBe(0);
  expect(await redisLindex(connection, testKey, 0)).toBeNull();
  expect(await redisLpop(connection, testKey)).toBeNull();
});

fixture("flush-queue", async (connection) => {
  const testKey = "naive-redis-queue-flush";
  const testValue = ["a", "b", "c", "d", "e"];
  expect(await redisRpush(connection, testKey, ...testValue)).toBe(5);
  expect(await redisLlen(connection, testKey)).toBe(5);
  expect(await redisLrange(connection, testKey, 0, -1)).toEqual(testValue);
  expect(await redisLtrim(connection, testKey, testValue.length)).toBeTruthy();
});
