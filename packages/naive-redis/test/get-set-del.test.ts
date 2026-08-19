import { expect } from "vitest";
import { redisDel, redisGet, redisSet } from "../src/index.js";
import { fixture } from "./fixture.js";

fixture("simple-get-set-del", async (connection) => {
  const testKey = "naive-redis-get-set-del-test";
  const testValue = JSON.stringify({ this: "is", something: 19391 });
  expect(await redisDel(connection, testKey)).toBe(0);
  expect(await redisGet(connection, testKey)).toBeNull();

  await redisSet(connection, testKey, testValue);
  expect(await redisGet(connection, testKey)).toEqual(testValue);
  expect(await redisDel(connection, testKey)).toBe(1);
  expect(await redisGet(connection, testKey)).toBeNull();
});

fixture("simple-get-set-del-many", async (connection) => {
  for (let index = 0; index < 100; ++index) {
    const testKey = `naive-redis-get-set-del-test-${index}`;
    const testValue = JSON.stringify({ this: "is", something: 19391, index });
    expect(await redisDel(connection, testKey)).toBe(0);
    expect(await redisGet(connection, testKey)).toBeNull();

    await redisSet(connection, testKey, testValue);
    expect(await redisGet(connection, testKey)).toEqual(testValue);
    expect(await redisDel(connection, testKey)).toBe(1);
    expect(await redisGet(connection, testKey)).toBeNull();
  }
});

fixture("del-many", async (connection) => {
  const count = 100;
  const keys: string[] = [];
  for (let index = 0; index < count; ++index) {
    const testKey = `naive-redis-get-set-del-test-${index}`;
    await redisSet(
      connection,
      testKey,
      JSON.stringify({ this: "is", something: 19391, index }),
    );
    keys.push(testKey);
  }
  expect(await redisDel(connection, ...keys)).toBe(count);
});
