import { describe, expect, it, vi } from "vitest";
import {
  enqueue,
  eventLoop,
  createInMemoryLock,
  createInMemoryQueue,
} from "../src/index.js";
import { nullLogger, type Logger } from "@yingyeothon/logger";

interface AdderMessage {
  delta: number;
}

class AdderLoop {
  public value = 0;

  public loop = async (poll: () => Promise<AdderMessage[]>): Promise<void> => {
    const messages = await poll();
    for (const { delta } of messages) {
      this.value += delta;
    }
  };
}

describe("eventLoop", () => {
  it("polls all queued items inside the user loop", async () => {
    const sharedEnv = {
      id: "loop-1",
      queue: createInMemoryQueue(),
      lock: createInMemoryLock(),
    };

    const loop = new AdderLoop();
    expect(await eventLoop<AdderMessage>({ ...sharedEnv, ...loop })).toBe(true);
    expect(loop.value).toEqual(0);

    for (let delta = 1; delta <= 10; delta++) {
      await enqueue<AdderMessage>(sharedEnv, { item: { delta } });
    }
    await eventLoop<AdderMessage>({ ...sharedEnv, ...loop });
    expect(loop.value).toEqual(55);

    for (let delta = 1; delta <= 10; delta++) {
      await enqueue<AdderMessage>(sharedEnv, { item: { delta } });
    }
    await eventLoop<AdderMessage>({ ...sharedEnv, ...loop });
    expect(loop.value).toEqual(110);
  });

  it("returns false without looping when the lock is held", async () => {
    const lock = createInMemoryLock();
    const queue = createInMemoryQueue();
    await lock.tryAcquire("loop-2");

    const loop = new AdderLoop();
    await enqueue<AdderMessage>(
      { id: "loop-2", queue },
      { item: { delta: 1 } },
    );
    expect(
      await eventLoop<AdderMessage>({ id: "loop-2", queue, lock, ...loop }),
    ).toBe(false);
    expect(loop.value).toEqual(0);
    expect(await queue.size("loop-2")).toEqual(1);
  });

  it("releases the lock even after the loop finishes", async () => {
    const lock = createInMemoryLock();
    const queue = createInMemoryQueue();
    const loop = new AdderLoop();
    const env = { id: "loop-3", queue, lock, ...loop };

    expect(await eventLoop<AdderMessage>(env)).toBe(true);
    // The lock must be reacquirable afterwards.
    expect(await lock.tryAcquire("loop-3")).toBe(true);
  });

  it("releases the lock when the loop throws", async () => {
    const lock = createInMemoryLock();
    const queue = createInMemoryQueue();

    await expect(
      eventLoop({
        id: "loop-4",
        queue,
        lock,
        loop: () => Promise.reject(new Error("game exploded")),
      }),
    ).rejects.toThrow("game exploded");

    // Without a finally the actor stays unstartable until the lease expires.
    expect(await lock.tryAcquire("loop-4")).toBe(true);
  });

  it("calls onAcquired only when this invocation owns the actor", async () => {
    const lock = createInMemoryLock();
    const queue = createInMemoryQueue();
    const order: string[] = [];
    const env = {
      id: "loop-5",
      queue,
      lock,
      onAcquired: () => {
        order.push("ready");
        return Promise.resolve();
      },
      loop: () => {
        order.push("loop");
        return Promise.resolve();
      },
    };

    // A second invocation runs while the first holds the lock.
    await lock.tryAcquire("loop-5");
    expect(await eventLoop(env)).toBe(false);
    expect(order).toEqual([]);

    await lock.release("loop-5");
    expect(await eventLoop(env)).toBe(true);
    expect(order).toEqual(["ready", "loop"]);
  });

  it("renews the lock while the loop runs and stops on the way out", async () => {
    vi.useFakeTimers();
    try {
      const inner = createInMemoryLock();
      const renewals: string[] = [];
      const lock = {
        ...inner,
        renew: (actorId: string) => {
          renewals.push(actorId);
          return Promise.resolve(true);
        },
      };
      let release = (): void => undefined;
      const finished = eventLoop({
        id: "loop-6",
        queue: createInMemoryQueue(),
        lock,
        lockRenewIntervalMillis: 100,
        loop: () => new Promise<void>((resolve) => (release = resolve)),
      });

      await vi.advanceTimersByTimeAsync(350);
      expect(renewals).toEqual(["loop-6", "loop-6", "loop-6"]);

      release();
      await finished;

      // The heartbeat must not outlive the loop, or it keeps a Lambda alive.
      await vi.advanceTimersByTimeAsync(500);
      expect(renewals).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs when the lock was lost instead of renewed", async () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      const logger: Logger = {
        ...nullLogger,
        error: (...args: unknown[]) => lines.push(args.join(" ")),
      };
      const inner = createInMemoryLock();
      let release = (): void => undefined;
      const finished = eventLoop({
        id: "loop-7",
        queue: createInMemoryQueue(),
        lock: { ...inner, renew: () => Promise.resolve(false) },
        lockRenewIntervalMillis: 100,
        logger,
        loop: () => new Promise<void>((resolve) => (release = resolve)),
      });

      await vi.advanceTimersByTimeAsync(150);
      expect(lines.some((line) => line.includes("lost the actor lock"))).toBe(
        true,
      );

      release();
      await finished;
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps going when a renewal round trip fails", async () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      const logger: Logger = {
        ...nullLogger,
        error: (...args: unknown[]) => lines.push(args.join(" ")),
      };
      const inner = createInMemoryLock();
      let polls = 0;
      let release = (): void => undefined;
      const finished = eventLoop({
        id: "loop-9",
        queue: createInMemoryQueue(),
        lock: {
          ...inner,
          // A broken round trip is not proof the lease is gone.
          renew: () => Promise.reject(new Error("connection reset")),
        },
        lockRenewIntervalMillis: 100,
        logger,
        loop: async (poll) => {
          await poll();
          polls++;
          await new Promise<void>((resolve) => (release = resolve));
        },
      });

      await vi.advanceTimersByTimeAsync(250);
      expect(
        lines.some((line) => line.includes("cannot renew the actor lock")),
      ).toBe(true);
      // Not treated as a loss: the loop is still running.
      expect(lines.some((line) => line.includes("lost the actor lock"))).toBe(
        false,
      );
      expect(polls).toBe(1);

      release();
      await finished;
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries on when the lease expired but nobody took the actor", async () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      const logger: Logger = {
        ...nullLogger,
        warn: (...args: unknown[]) => lines.push(args.join(" ")),
        error: (...args: unknown[]) => lines.push(args.join(" ")),
      };
      const inner = createInMemoryLock();
      let polls = 0;
      let release = (): void => undefined;

      // The lease lapses — a store outage longer than it — and the key is
      // free, because no successor ever wanted this actor.
      const finished = eventLoop({
        id: "loop-12",
        queue: createInMemoryQueue(),
        lock: {
          ...inner,
          renew: async (actorId: string) => {
            await inner.release(actorId);
            return false;
          },
        },
        lockRenewIntervalMillis: 50,
        logger,
        loop: async (poll) => {
          await poll();
          polls++;
          await new Promise((resolve) => setTimeout(resolve, 200));
          // Still ours, so this must still be allowed.
          await poll();
          polls++;
          await new Promise<void>((resolve) => (release = resolve));
        },
      });

      await vi.advanceTimersByTimeAsync(300);
      expect(polls).toBe(2);
      expect(
        lines.some((line) => line.includes("re-acquired the actor lock")),
      ).toBe(true);
      // Nothing was taken from anyone, so this is not a loss.
      expect(lines.some((line) => line.includes("lost the actor lock"))).toBe(
        false,
      );

      release();
      await finished;
      // And the lock is still released cleanly at the end.
      expect(await inner.tryAcquire("loop-12")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to poll once the lease is gone", async () => {
    vi.useFakeTimers();
    try {
      const inner = createInMemoryLock();
      let lost = 0;
      // This invocation acquires normally; by the time the heartbeat tries
      // to re-acquire, a successor holds the actor and it cannot.
      let acquired = false;
      const finished = eventLoop({
        id: "loop-10",
        queue: createInMemoryQueue(),
        lock: {
          release: (actorId: string) => inner.release(actorId),
          tryAcquire: async (actorId: string) => {
            if (acquired) {
              return false;
            }
            acquired = await inner.tryAcquire(actorId);
            return acquired;
          },
          renew: () => Promise.resolve(false),
        },
        lockRenewIntervalMillis: 100,
        onLockLost: () => lost++,
        loop: async (poll) => {
          await poll();
          await new Promise((resolve) => setTimeout(resolve, 200));
          // Flushing here would take the new owner's messages.
          await poll();
        },
      });

      // Attach the expectation before advancing time: the loop rejects
      // during the advance, and an unobserved rejection fails the whole run.
      const outcome = expect(finished).rejects.toThrow("Actor lock lost");
      await vi.advanceTimersByTimeAsync(400);
      await outcome;
      expect(lost).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("warns about a renewable lease with no heartbeat", async () => {
    const lines: string[] = [];
    const logger: Logger = {
      ...nullLogger,
      warn: (...args: unknown[]) => lines.push(args.join(" ")),
    };
    const inner = createInMemoryLock();

    await eventLoop({
      id: "loop-11",
      queue: createInMemoryQueue(),
      lock: { ...inner, renew: () => Promise.resolve(true) },
      logger,
      loop: () => Promise.resolve(),
    });

    // A short lease with no heartbeat expires mid-game, silently.
    expect(
      lines.some((line) => line.includes("held without a heartbeat")),
    ).toBe(true);
  });

  it("runs without a heartbeat when the lock cannot renew", async () => {
    const lock = createInMemoryLock();
    let looped = false;
    expect(
      await eventLoop({
        id: "loop-8",
        queue: createInMemoryQueue(),
        lock,
        lockRenewIntervalMillis: 10,
        loop: () => {
          looped = true;
          return Promise.resolve();
        },
      }),
    ).toBe(true);
    expect(looped).toBe(true);
  });
});
