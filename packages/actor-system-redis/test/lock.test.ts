import { expect } from "vitest";
import { createRedisLock } from "../src/index.js";
import { fixture } from "./fixture.js";

fixture("lock acquire and release", async (connection) => {
  const lock = createRedisLock({ connection });
  const actorId = "test-actor";
  await lock.release(actorId);

  expect(await lock.tryAcquire(actorId)).toBe(true);
  expect(await lock.tryAcquire(actorId)).toBe(false);
  expect(await lock.tryAcquire(actorId)).toBe(false);

  expect(await lock.release(actorId)).toBe(true);
  expect(await lock.tryAcquire(actorId)).toBe(true);
  expect(await lock.tryAcquire(actorId)).toBe(false);
  expect(await lock.release(actorId)).toBe(true);
});

fixture("lock expires after lockTimeout", async (connection) => {
  const lock = createRedisLock({
    connection,
    keyPrefix: "expiring:",
    lockTimeout: 100,
  });
  const actorId = "test-actor";

  expect(await lock.tryAcquire(actorId)).toBe(true);
  expect(await lock.tryAcquire(actorId)).toBe(false);

  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(await lock.tryAcquire(actorId)).toBe(true);
  expect(await lock.release(actorId)).toBe(true);
});
