import { describe, expect, it } from "vitest";
import {
  createInMemoryAwaiter,
  createInMemoryLock,
  createInMemoryQueue,
  post,
  singleConsumer,
  tryToProcess,
  type LockAcquire,
  type LockRelease,
} from "../src/index.js";

interface AdderMessage {
  delta: number;
}

type Event = "acquire" | "release" | "shift" | `message:${number}`;

/**
 * Wraps a lock so the order of ownership events is observable. The point of
 * holding the lock across drain cycles is a sequence, not a count, so the
 * assertions have to be about the sequence.
 */
function recordingLock(
  inner: LockAcquire & LockRelease,
  events: Event[],
): LockAcquire & LockRelease {
  return {
    tryAcquire: async (actorId) => {
      const acquired = await inner.tryAcquire(actorId);
      if (acquired) {
        events.push("acquire");
      }
      return acquired;
    },
    release: async (actorId) => {
      events.push("release");
      return inner.release(actorId);
    },
  };
}

function countingLock<T extends { lock: LockAcquire & LockRelease }>(
  env: T,
  inner: LockAcquire & LockRelease,
  attempts: number[],
): T {
  return {
    ...env,
    lock: {
      tryAcquire: (actorId: string) => {
        attempts.push(1);
        return inner.tryAcquire(actorId);
      },
      release: (actorId: string) => inner.release(actorId),
    },
  };
}

function newEnv(events: Event[], id: string) {
  const queue = createInMemoryQueue();
  const lock = createInMemoryLock();
  return {
    queue,
    lock,
    events,
    env: {
      ...singleConsumer,
      id,
      queue,
      awaiter: createInMemoryAwaiter(),
      lock: recordingLock(lock, events),
      onMessage: ({ delta }: AdderMessage) => {
        events.push(`message:${delta}`);
      },
    },
  };
}

describe("lock ownership across drain cycles", () => {
  it("acquires once and releases once for a whole call", async () => {
    const events: Event[] = [];
    const { env } = newEnv(events, "held-across");

    await post(env, { item: { delta: 1 } });
    await post(env, { item: { delta: 2 } });
    await post(env, { item: { delta: 3 } });

    const metas = await tryToProcess(env, { aliveMillis: 50 });

    expect(metas).toHaveLength(3);
    expect(events).toEqual([
      "acquire",
      "message:1",
      "message:2",
      "message:3",
      "release",
    ]);
  });

  it("keeps the lock while a handler enqueues more work", async () => {
    const events: Event[] = [];
    const queue = createInMemoryQueue();
    const lock = createInMemoryLock();
    let remaining = 2;
    const env = {
      ...singleConsumer,
      id: "refilling",
      queue,
      awaiter: createInMemoryAwaiter(),
      lock: recordingLock(lock, events),
      onMessage: ({ delta }: AdderMessage) => {
        events.push(`message:${delta}`);
      },
    };

    // A handler that refills the queue forces more than one drain cycle.
    const refilling = {
      ...env,
      onMessage: async ({ delta }: AdderMessage) => {
        events.push(`message:${delta}`);
        if (remaining-- > 0) {
          await post(env, { item: { delta: delta + 1 } });
        }
      },
    };

    await post(env, { item: { delta: 1 } });
    await tryToProcess(refilling, { oneShot: true });

    expect(events.filter((event) => event === "acquire")).toHaveLength(1);
    expect(events.filter((event) => event === "release")).toHaveLength(1);
    // Nothing was released between the messages.
    expect(events.indexOf("release")).toBe(events.length - 1);
    expect(events).toContain("message:3");
  });

  it("releases the lock before shifting, so the successor can acquire", async () => {
    const events: Event[] = [];
    const queue = createInMemoryQueue();
    const lock = createInMemoryLock();
    let acquiredBySuccessor: boolean | undefined;
    const env = {
      ...singleConsumer,
      id: "shifting",
      queue,
      awaiter: createInMemoryAwaiter(),
      lock: recordingLock(lock, events),
      onMessage: () => undefined,
      shift: async (actorId: string) => {
        events.push("shift");
        // The successor invocation runs here; without a release first it
        // could never take ownership.
        acquiredBySuccessor = await lock.tryAcquire(actorId);
      },
    };

    await tryToProcess(env, { aliveMillis: 1, shiftable: true });

    expect(acquiredBySuccessor).toBe(true);
    expect(events).toEqual(["acquire", "release", "shift"]);
  });

  it("releases the lock when the queue itself fails", async () => {
    const events: Event[] = [];
    const queue = createInMemoryQueue();
    const lock = createInMemoryLock();
    const env = {
      ...singleConsumer,
      id: "throwing",
      queue,
      awaiter: createInMemoryAwaiter(),
      lock: recordingLock(lock, events),
      onMessage: () => undefined,
      // `queue.size` throwing escapes the handler's own try/catch, which is
      // what makes this reach the finally rather than `onError`.
      _consume: "single" as const,
    };
    const broken = {
      ...env,
      queue: {
        ...queue,
        size: () => Promise.reject(new Error("redis is gone")),
      },
    };

    await expect(tryToProcess(broken)).rejects.toThrow("redis is gone");
    expect(events).toEqual(["acquire", "release"]);
    // The actor is immediately startable again.
    expect(await lock.tryAcquire("throwing")).toBe(true);
  });

  it("gives up on the first miss for a one-shot call", async () => {
    const events: Event[] = [];
    const { env, lock } = newEnv(events, "contended");
    await post(env, { item: { delta: 1 } });
    await lock.tryAcquire("contended");

    const attempts: number[] = [];
    const counting = countingLock(env, lock, attempts);

    const metas = await tryToProcess(counting, { oneShot: true });

    expect(metas).toEqual([]);
    expect(attempts).toHaveLength(1);
  });

  it("waits for the current owner when it was asked to stay alive", async () => {
    const events: Event[] = [];
    const { env, lock } = newEnv(events, "waiting");
    await post(env, { item: { delta: 1 } });
    await lock.tryAcquire("waiting");

    const attempts: number[] = [];
    const counting = countingLock(env, lock, attempts);

    // The owner finishes shortly after this call starts.
    setTimeout(() => void lock.release("waiting"), 60);
    const metas = await tryToProcess(counting, {
      aliveMillis: 1000,
      idleIntervalMillis: 20,
    });

    // It took the actor over rather than reporting nothing to do.
    expect(metas).toHaveLength(1);
    // And it waited at the idle interval rather than spinning: a hot retry
    // would be thousands of attempts, not a handful.
    expect(attempts.length).toBeGreaterThan(1);
    expect(attempts.length).toBeLessThan(20);
  });

  it("does not spin while an empty queue stays empty", async () => {
    const events: Event[] = [];
    const { env } = newEnv(events, "idling");
    let sizeCalls = 0;
    const counted = {
      ...env,
      queue: {
        ...env.queue,
        size: (actorId: string) => {
          sizeCalls++;
          return env.queue.size(actorId);
        },
      },
    };

    await tryToProcess(counted, { aliveMillis: 200, idleIntervalMillis: 20 });

    // Previously this loop ran as fast as the event loop allowed, for the
    // whole of `aliveMillis`, while holding the lock.
    expect(sizeCalls).toBeLessThan(50);
  });
});
