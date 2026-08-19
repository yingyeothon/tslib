import { describe, expect, it } from "vitest";
import {
  AwaitPolicy,
  bulkConsumer,
  InMemoryAwaiter,
  InMemoryLock,
  InMemoryQueue,
  post,
  tryToProcess,
} from "../src/index.js";

interface AdderMessage {
  delta: number;
}

class Adder {
  public value = 0;

  constructor(public readonly id: string) {}

  public onMessages = (messages: AdderMessage[]): void => {
    for (const { delta } of messages) {
      this.value += delta;
    }
  };
}

function newSubsys() {
  return {
    queue: new InMemoryQueue(),
    lock: new InMemoryLock(),
    awaiter: new InMemoryAwaiter(),
  };
}

describe("bulk-mode actor", () => {
  it("processes all queued messages in one flush", async () => {
    const adder = new Adder("adder");
    const env = { ...bulkConsumer, ...newSubsys(), ...adder };

    expect(adder.value).toEqual(0);

    await post(env, { item: { delta: 1 } });
    expect(adder.value).toEqual(0);

    await post(env, { item: { delta: 1 } });
    expect(adder.value).toEqual(0);

    await post(env, { item: { delta: 1 } });
    expect(adder.value).toEqual(0);

    await tryToProcess(env);
    expect(adder.value).toEqual(3);

    await tryToProcess(env);
    expect(adder.value).toEqual(3);
  });

  it("resolves Act awaiters processed by another caller", async () => {
    const adder = new Adder("adder");
    const env = { ...bulkConsumer, ...newSubsys(), ...adder };

    const posted = post(env, {
      item: { delta: 2 },
      awaitPolicy: AwaitPolicy.Act,
    });
    const metas = await tryToProcess(env);
    expect(metas).toHaveLength(1);
    expect(await posted).toBe(true);
    expect(adder.value).toEqual(2);
  });

  it("keeps processing after a handler error and reports it to onError", async () => {
    const errors: Error[] = [];
    const env = {
      ...bulkConsumer,
      ...newSubsys(),
      id: "boom",
      onMessages: () => {
        throw new Error("bulk-broken");
      },
      onError: (error: Error) => {
        errors.push(error);
      },
    };

    await post(env, { item: { delta: 1 } });
    await post(env, { item: { delta: 1 } });
    const metas = await tryToProcess(env);
    expect(metas).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toEqual("bulk-broken");
  });

  it("swallows handler errors when no onError is given", async () => {
    const env = {
      ...bulkConsumer,
      ...newSubsys(),
      id: "boom-silent",
      onMessages: () => {
        throw new Error("bulk-broken");
      },
    };

    await post(env, { item: { delta: 1 } });
    await expect(tryToProcess(env)).resolves.toHaveLength(1);
  });

  it("logs and survives a failing awaiter.resolve", async () => {
    const logged: unknown[][] = [];
    const env = {
      ...bulkConsumer,
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
      onMessages: () => undefined,
    };

    await post(env, { item: { delta: 1 }, awaitPolicy: AwaitPolicy.Act });
    const metas = await tryToProcess(env);
    expect(metas).toHaveLength(1);
    // Wait a tick so the fire-and-forget notification settles.
    await new Promise((resolve) => setImmediate(resolve));
    expect(logged.length).toBeGreaterThan(0);
  });
});
