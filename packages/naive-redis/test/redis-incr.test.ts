import { expect } from "vitest";
import { redisDel, redisGet, redisIncr, redisSet } from "../src/index.js";
import { fixture } from "./fixture.js";

fixture("simple-incr", async (connection) => {
  const testKey = "naive-redis-incr";
  expect(await redisDel(connection, testKey)).toBe(0);
  expect(await redisGet(connection, testKey)).toBeNull();

  await redisSet(connection, testKey, "10");
  expect(await redisGet(connection, testKey)).toEqual("10");
  expect(await redisIncr(connection, testKey)).toBe(11);
  expect(await redisGet(connection, testKey)).toEqual("11");
  expect(await redisDel(connection, testKey)).toBe(1);
  expect(await redisGet(connection, testKey)).toBeNull();
  expect(await redisIncr(connection, testKey)).toBe(1);
  expect(await redisGet(connection, testKey)).toEqual("1");
  expect(await redisDel(connection, testKey)).toBe(1);
  expect(await redisGet(connection, testKey)).toBeNull();
});
