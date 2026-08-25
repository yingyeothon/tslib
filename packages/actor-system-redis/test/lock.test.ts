import { expect } from "vitest";
import { redisDel } from "@yingyeothon/naive-redis";
import { createRedisLock } from "../src/index.js";
import { fixture } from "./fixture.js";

fixture("lock acquire and release", async (connection) => {
  const lock = createRedisLock({ connection, lockTimeout: 5000 });
  const actorId = "test-actor";

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

fixture("release never deletes another holder's lock", async (connection) => {
  const actorId = "contended";
  const options = { connection, keyPrefix: "token:", lockTimeout: 150 };
  const stalled = createRedisLock(options);
  const successor = createRedisLock(options);

  expect(await stalled.tryAcquire(actorId)).toBe(true);

  // The first holder stalls past its lease and the second takes over.
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(await successor.tryAcquire(actorId)).toBe(true);

  // The stalled holder now finishes. With an unconditional DEL this would
  // free the successor's lock and let two actors run the same game.
  expect(await stalled.release(actorId)).toBe(false);
  expect(await stalled.tryAcquire(actorId)).toBe(false);

  expect(await successor.release(actorId)).toBe(true);
  expect(await successor.tryAcquire(actorId)).toBe(true);
});

fixture(
  "release refuses when this process never acquired",
  async (connection) => {
    const options = { connection, keyPrefix: "foreign:", lockTimeout: 5000 };
    const owner = createRedisLock(options);
    const stranger = createRedisLock(options);

    expect(await owner.tryAcquire("actor")).toBe(true);
    expect(await stranger.release("actor")).toBe(false);
    expect(await stranger.tryAcquire("actor")).toBe(false);
  },
);

fixture(
  "renew extends only a lease this holder still owns",
  async (connection) => {
    const actorId = "renewing";
    const options = { connection, keyPrefix: "renew:", lockTimeout: 300 };
    const owner = createRedisLock(options);
    const other = createRedisLock(options);

    expect(await owner.tryAcquire(actorId)).toBe(true);

    // Heartbeat twice across what would otherwise have been two expiries.
    for (let beat = 0; beat < 2; beat++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await owner.renew(actorId)).toBe(true);
    }
    expect(await other.tryAcquire(actorId)).toBe(false);

    // Nobody else can extend it.
    expect(await other.renew(actorId)).toBe(false);

    // Once it does expire, renewal reports the loss instead of resurrecting it.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await owner.renew(actorId)).toBe(false);
    expect(await other.tryAcquire(actorId)).toBe(true);
    expect(await other.release(actorId)).toBe(true);
  },
);

fixture(
  "a non-positive lockTimeout is an explicit no-expiry lock",
  async (connection) => {
    const lock = createRedisLock({
      connection,
      keyPrefix: "forever:",
      lockTimeout: -1,
    });

    expect(await lock.tryAcquire("actor")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await lock.tryAcquire("actor")).toBe(false);
    // There is no lease to extend, but ownership is still checked.
    expect(await lock.renew("actor")).toBe(true);
    expect(await lock.release("actor")).toBe(true);
  },
);

fixture(
  "renew reports a no-expiry lock that was broken by hand",
  async (connection) => {
    const lock = createRedisLock({
      connection,
      keyPrefix: "broken:",
      lockTimeout: -1,
    });

    expect(await lock.tryAcquire("actor")).toBe(true);
    expect(await lock.renew("actor")).toBe(true);

    // `handleDebugStart` breaks a stale lock exactly like this, and a key
    // can also be evicted under `maxmemory`.
    await redisDel(connection, "broken:actor");

    expect(await lock.renew("actor")).toBe(false);
  },
);

fixture(
  "release stays retryable after a failed attempt",
  async (connection) => {
    const actorId = "retryable";
    let failNextEval = true;
    const flaky = {
      ...connection,
      socket: {
        ...connection.socket,
        send: (request: Parameters<typeof connection.socket.send>[0]) => {
          if (request.message.includes("EVAL") && failNextEval) {
            failNextEval = false;
            return Promise.reject(new Error("connection reset"));
          }
          return connection.socket.send(request);
        },
      },
    };
    const lock = createRedisLock({
      connection: flaky,
      keyPrefix: "retry:",
      lockTimeout: 30_000,
    });

    expect(await lock.tryAcquire(actorId)).toBe(true);
    await expect(lock.release(actorId)).rejects.toThrow("connection reset");

    // Forgetting the token on the failed attempt would leave the lock held
    // until it expires, with nobody able to release it.
    expect(await lock.release(actorId)).toBe(true);

    const other = createRedisLock({
      connection,
      keyPrefix: "retry:",
      lockTimeout: 30_000,
    });
    expect(await other.tryAcquire(actorId)).toBe(true);
  },
);
