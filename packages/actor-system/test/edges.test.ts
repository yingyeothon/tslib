import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AwaitPolicy,
  InMemoryAwaiter,
  InMemoryLock,
  InMemoryQueue,
  post,
  send,
  singleConsumer,
  tryToProcess,
} from "../src/index.js";

interface AdderMessage {
  delta: number;
}

function newSubsys() {
  return {
    queue: new InMemoryQueue(),
    lock: new InMemoryLock(),
    awaiter: new InMemoryAwaiter(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("lock contention", () => {
  it("tryToProcess consumes nothing while the lock is held", async () => {
    const subsys = newSubsys();
    let value = 0;
    const env = {
      ...singleConsumer,
      ...subsys,
      id: "held",
      onMessage: ({ delta }: AdderMessage) => {
        value += delta;
      },
    };

    await post(env, { item: { delta: 1 } });
    await subsys.lock.tryAcquire("held");

    const metas = await tryToProcess(env);
    expect(metas).toHaveLength(0);
    expect(value).toEqual(0);
    expect(await subsys.queue.size("held")).toEqual(1);

    await subsys.lock.release("held");
    expect(await tryToProcess(env)).toHaveLength(1);
    expect(value).toEqual(1);
  });
});

describe("single-mode error handling", () => {
  it("keeps message order and continues after a handler error", async () => {
    const seen: number[] = [];
    const errors: Error[] = [];
    const env = {
      ...singleConsumer,
      ...newSubsys(),
      id: "half-broken",
      onMessage: ({ delta }: AdderMessage) => {
        if (delta === 2) {
          throw new Error(`broken-${delta}`);
        }
        seen.push(delta);
      },
      onError: (error: Error) => {
        errors.push(error);
      },
    };

    for (const delta of [1, 2, 3]) {
      await post(env, { item: { delta } });
    }
    const metas = await tryToProcess(env);
    expect(metas).toHaveLength(3);
    expect(seen).toEqual([1, 3]);
    expect(errors.map((error) => error.message)).toEqual(["broken-2"]);
  });

  it("swallows handler errors when no onError is given", async () => {
    const env = {
      ...singleConsumer,
      ...newSubsys(),
      id: "silent",
      onMessage: () => {
        throw new Error("silent-broken");
      },
    };

    await post(env, { item: { delta: 1 } });
    await expect(tryToProcess(env)).resolves.toHaveLength(1);
  });

  it("logs and survives a failing awaiter.resolve for Act messages", async () => {
    const logged: unknown[][] = [];
    const env = {
      ...singleConsumer,
      id: "bad-awaiter",
      queue: new InMemoryQueue(),
      lock: new InMemoryLock(),
      awaiter: {
        resolve: () => Promise.reject(new Error("resolve-broken")),
        wait: () => Promise.resolve(true),
      },
      logger: {
        debug: () => undefined,
        info: () => undefined,
        error: (...args: unknown[]) => {
          logged.push(args);
        },
      },
      onMessage: () => undefined,
    };

    await post(env, { item: { delta: 1 }, awaitPolicy: AwaitPolicy.Act });
    const metas = await tryToProcess(env);
    expect(metas).toHaveLength(1);
    expect(logged.length).toBeGreaterThan(0);
  });
});

describe("processing loop continuation", () => {
  it("reprocesses when new messages arrive before the loop exits", async () => {
    const subsys = newSubsys();
    const seen: number[] = [];
    let refilled = false;
    const env = {
      ...singleConsumer,
      ...subsys,
      id: "refill",
      onMessage: ({ delta }: AdderMessage) => {
        seen.push(delta);
      },
      onCommit: async () => {
        if (!refilled) {
          refilled = true;
          await subsys.queue.push("refill", {
            messageId: "refill-message",
            awaitPolicy: AwaitPolicy.Forget,
            awaitTimeoutMillis: 0,
            item: { delta: 99 },
          });
        }
      },
    };

    await post(env, { item: { delta: 1 } });
    const metas = await tryToProcess(env);
    expect(metas).toHaveLength(2);
    expect(seen).toEqual([1, 99]);
    expect(await subsys.queue.size("refill")).toEqual(0);
  });
});

describe("broken or expiring environments", () => {
  it("stops when the queue reports items but yields no message", async () => {
    const sizes = [1, 0];
    const env = {
      ...singleConsumer,
      id: "broken-queue",
      lock: new InMemoryLock(),
      awaiter: new InMemoryAwaiter(),
      queue: {
        push: () => Promise.resolve(),
        size: () => Promise.resolve(sizes.shift() ?? 0),
        peek: <T>() => Promise.resolve(null as T | null),
        pop: <T>() => Promise.resolve(null as T | null),
      },
      onMessage: () => undefined,
    };

    await expect(tryToProcess(env)).resolves.toHaveLength(0);
  });

  it("consumes nothing when the lifetime expires while acquiring the lock", async () => {
    vi.useFakeTimers();
    const subsys = newSubsys();
    const slowLock = {
      tryAcquire: async (actorId: string) => {
        vi.setSystemTime(Date.now() + 100);
        return subsys.lock.tryAcquire(actorId);
      },
      release: (actorId: string) => subsys.lock.release(actorId),
    };
    let value = 0;
    const env = {
      ...singleConsumer,
      ...subsys,
      lock: slowLock,
      id: "expiring",
      onMessage: ({ delta }: AdderMessage) => {
        value += delta;
      },
    };

    await post(env, { item: { delta: 1 } });
    const metas = await tryToProcess(env, { aliveMillis: 50 });
    expect(metas).toHaveLength(0);
    expect(value).toEqual(0);
    expect(await subsys.queue.size("expiring")).toEqual(1);
  });
});

describe("send in-thread awaiting", () => {
  it("returns true when the message is processed by this thread", async () => {
    let value = 0;
    const env = {
      ...singleConsumer,
      ...newSubsys(),
      id: "in-thread",
      onMessage: ({ delta }: AdderMessage) => {
        value += delta;
      },
    };

    await expect(
      send(env, { item: { delta: 5 }, awaitPolicy: AwaitPolicy.Act }),
    ).resolves.toBe(true);
    expect(value).toEqual(5);
  });

  it("returns true immediately for Forget messages", async () => {
    const env = {
      ...singleConsumer,
      ...newSubsys(),
      id: "forget",
      onMessage: () => undefined,
    };

    await expect(send(env, { item: { delta: 1 } })).resolves.toBe(true);
  });
});
