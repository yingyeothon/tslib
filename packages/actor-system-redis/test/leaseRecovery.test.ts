import { eventLoop, createInMemoryQueue } from "@yingyeothon/actor-system";
import { redisGet } from "@yingyeothon/naive-redis";
import { expect } from "vitest";
import { createRedisLock } from "../src/index.js";
import { fixture } from "./fixture.js";

/**
 * The lease is short so a crashed actor frees its id quickly. These cover
 * the other side of that trade: a *live* actor that lost contact with Redis
 * for longer than the lease must not lose its game to the outage.
 */
fixture(
  "a game survives an outage longer than its lease",
  async (connection) => {
    const lock = createRedisLock({
      connection,
      keyPrefix: "lease:",
      lockTimeout: 200,
    });
    const polls: number[] = [];

    const ran = await eventLoop({
      id: "survivor",
      queue: createInMemoryQueue(),
      lock,
      // Deliberately slower than the lease, so a beat cannot save it: the
      // key really does expire mid-game.
      lockRenewIntervalMillis: 500,
      loop: async (poll) => {
        polls.push((await poll()).length);
        await new Promise((resolve) => setTimeout(resolve, 700));
        // The lease lapsed and came back; the game is still ours.
        polls.push((await poll()).length);
      },
    });

    expect(ran).toBe(true);
    expect(polls).toEqual([0, 0]);
    // Re-acquired, then released cleanly rather than left behind.
    expect(await redisGet(connection, "lease:survivor")).toBeNull();
  },
);

fixture(
  "a game stops when a successor actually took the actor",
  async (connection) => {
    const holder = createRedisLock({
      connection,
      keyPrefix: "taken:",
      lockTimeout: 200,
    });
    // The successor holds it properly, so the holder's re-acquisition has
    // something real to fail against.
    const successor = createRedisLock({
      connection,
      keyPrefix: "taken:",
      lockTimeout: 30_000,
    });

    await expect(
      eventLoop({
        id: "handed-over",
        queue: createInMemoryQueue(),
        lock: holder,
        lockRenewIntervalMillis: 500,
        loop: async (poll) => {
          await poll();
          // The lease lapses and a second actor claims the game.
          await new Promise((resolve) => setTimeout(resolve, 300));
          expect(await successor.tryAcquire("handed-over")).toBe(true);
          await new Promise((resolve) => setTimeout(resolve, 500));
          // Flushing now would take the successor's messages.
          await poll();
        },
      }),
    ).rejects.toThrow("Actor lock lost");

    // The loser's release must not have deleted the successor's lock.
    expect(await successor.renew("handed-over")).toBe(true);
    expect(await successor.release("handed-over")).toBe(true);
  },
);
