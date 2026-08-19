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

class Adder {
  public value = 0;
  public state: undefined | "prepared" | "committed";

  constructor(public readonly id: string) {}

  public onPrepare = (): void => {
    this.state = "prepared";
  };
  public onCommit = (): void => {
    this.state = "committed";
  };
  public onMessage = ({ delta }: AdderMessage): void => {
    this.value += delta;
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("awaiting an actor", () => {
  it("awaits commits, in-thread or resolved by another processor", async () => {
    const actorSubsys = {
      queue: new InMemoryQueue(),
      lock: new InMemoryLock(),
      awaiter: new InMemoryAwaiter(),
    };
    const adder = new Adder("adder");
    const env = { ...singleConsumer, ...actorSubsys, ...adder };

    expect(adder.state).toBeUndefined();
    expect(adder.value).toEqual(0);

    await send(env, {
      item: { delta: 1 },
      awaitPolicy: AwaitPolicy.Commit,
    });
    expect(adder.state).toEqual("committed");
    expect(adder.value).toEqual(1);

    await send(env, {
      item: { delta: 1 },
      awaitPolicy: AwaitPolicy.Commit,
    });
    expect(adder.state).toEqual("committed");
    expect(adder.value).toEqual(2);

    vi.useFakeTimers();
    const orderSet: string[] = [];
    setTimeout(() => {
      orderSet.push("first");
      void tryToProcess(env);
    }, 50);

    const posted = post(env, {
      item: { delta: 1 },
      awaitPolicy: AwaitPolicy.Commit,
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(await posted).toBe(true);
    orderSet.push("second");
    expect(adder.state).toEqual("committed");
    expect(adder.value).toEqual(3);
    expect(orderSet).toEqual(["first", "second"]);
  });

  it("returns false when an awaited post times out unprocessed", async () => {
    vi.useFakeTimers();
    const env = {
      id: "lonely",
      queue: new InMemoryQueue(),
      awaiter: new InMemoryAwaiter(),
    };

    const posted = post(env, {
      item: { delta: 1 },
      awaitPolicy: AwaitPolicy.Act,
      awaitTimeoutMillis: 100,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(await posted).toBe(false);
  });

  it("returns false when send cannot process (lock contention) and times out", async () => {
    vi.useFakeTimers();
    const lock = new InMemoryLock();
    const adder = new Adder("contended");
    const env = {
      ...singleConsumer,
      queue: new InMemoryQueue(),
      lock,
      awaiter: new InMemoryAwaiter(),
      ...adder,
    };

    // Another "thread" holds the lock, so this send cannot process in-thread.
    expect(await lock.tryAcquire("contended")).toBe(true);

    const sent = send(env, {
      item: { delta: 1 },
      awaitPolicy: AwaitPolicy.Act,
      awaitTimeoutMillis: 200,
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(await sent).toBe(false);
    expect(adder.value).toEqual(0);

    // Once released, the queued message is still there to be processed.
    await lock.release("contended");
    const metas = await tryToProcess(env);
    expect(metas).toHaveLength(1);
    expect(adder.value).toEqual(1);
  });
});
