import { expect } from "vitest";
import { redisGet, redisSet } from "../src/index.js";
import { fixture } from "./fixture.js";

fixture("big-get-set", async (connection) => {
  const testKey = "naive-redis-set-big";
  const testValue = Array(1 << 18)
    .fill(0)
    .map((_, index) => index % 10)
    .join("");
  expect(
    await redisSet(connection, testKey, testValue, {
      expirationMillis: 50000,
      onlySet: "nx",
    }),
  ).toBe(true);
  expect(await redisGet(connection, testKey)).toEqual(testValue);
});
