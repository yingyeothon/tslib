import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryAwaiter,
  InMemoryLock,
  InMemoryQueue,
  post,
  singleConsumer,
  tryToProcess,
} from "../src/index.js";

interface AdderMessage {
  delta: number;
}

const ttl = 50;

const sleep = (millis: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, millis));

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
  public onMessage = async ({ delta }: AdderMessage): Promise<void> => {
    this.value += delta;
    await sleep(ttl);
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("shiftable processing", () => {
  it("shifts to a new actor whenever aliveMillis expires with messages left", async () => {
    vi.useFakeTimers();
    const actorSubsys = {
      queue: new InMemoryQueue(),
      lock: new InMemoryLock(),
      awaiter: new InMemoryAwaiter(),
    };
    const actor = new Adder("adder");

    let shiftCount = 0;
    const env = {
      ...singleConsumer,
      ...actorSubsys,
      ...actor,
      shift: () => ++shiftCount,
    };

    expect(actor.state).toBeUndefined();
    expect(actor.value).toEqual(0);
    expect(shiftCount).toEqual(0);

    for (let i = 0; i < 3; i++) {
      await post(env, { item: { delta: 1 } });
      expect(actor.state).toBeUndefined();
      expect(actor.value).toEqual(0);
      expect(shiftCount).toEqual(0);
    }

    for (let round = 1; round <= 3; round++) {
      const processing = tryToProcess(env, {
        aliveMillis: ttl,
        shiftable: true,
      });
      await vi.advanceTimersByTimeAsync(ttl);
      await processing;
      expect(actor.state).toEqual("committed");
      expect(actor.value).toEqual(round);
      expect(shiftCount).toEqual(round);
    }
  });

  it("does not call shift when it finishes within its lifetime", async () => {
    const actorSubsys = {
      queue: new InMemoryQueue(),
      lock: new InMemoryLock(),
      awaiter: new InMemoryAwaiter(),
    };

    let shiftCount = 0;
    const env = {
      ...singleConsumer,
      ...actorSubsys,
      id: "fast",
      onMessage: () => undefined,
      shift: () => ++shiftCount,
    };

    await post(env, { item: { delta: 1 } });
    const metas = await tryToProcess(env, { oneShot: true, shiftable: true });
    expect(metas).toHaveLength(1);
    expect(shiftCount).toEqual(0);
  });
});
