import { expect } from "vitest";
import { RedisAwaiter } from "../src/index.js";
import { fixture } from "./fixture.js";

fixture("wait returns true once resolved", async (connection) => {
  const awaiter = new RedisAwaiter({ connection, keyPrefix: "awaiter:" });

  setTimeout(() => {
    void awaiter.resolve("actor", "message");
  }, 80);
  expect(await awaiter.wait("actor", "message", 1000)).toBe(true);
});

fixture(
  "wait returns true for an already resolved message",
  async (connection) => {
    const awaiter = new RedisAwaiter({ connection });

    await awaiter.resolve("actor", "message");
    expect(await awaiter.wait("actor", "message", 1000)).toBe(true);
  },
);

fixture("wait returns false when the timeout elapses", async (connection) => {
  const awaiter = new RedisAwaiter({ connection });

  const start = Date.now();
  expect(await awaiter.wait("actor", "never-resolved", 150)).toBe(false);
  expect(Date.now() - start).toBeGreaterThanOrEqual(150);
});
