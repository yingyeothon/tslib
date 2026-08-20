import { describe, expect, it } from "vitest";
import {
  enqueue,
  eventLoop,
  createInMemoryLock,
  createInMemoryQueue,
} from "../src/index.js";

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
});
