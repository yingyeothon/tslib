import { expect } from "vitest";
import { redisExists, redisSet } from "../src/index.js";
import { fixture } from "./fixture.js";

fixture("simple-exists", async (connection) => {
  expect(await redisSet(connection, "key1", "Hello")).toBe(true);
  expect(await redisExists(connection, "key1")).toBe(1);

  expect(await redisExists(connection, "nosuchkey")).toBe(0);

  expect(await redisSet(connection, "key2", "World")).toBe(true);
  expect(await redisExists(connection, "key1", "key2", "nosuchkey")).toBe(2);
});
