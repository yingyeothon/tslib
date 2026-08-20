import { describe, expect, it } from "vitest";
import {
  enqueue,
  createInMemoryAwaiter,
  createInMemoryLock,
  createInMemoryQueue,
  post,
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

describe("single-mode actor", () => {
  it("processes enqueued and posted messages via tryToProcess", async () => {
    const actorSubsys = {
      queue: createInMemoryQueue(),
      lock: createInMemoryLock(),
      awaiter: createInMemoryAwaiter(),
    };
    const adder = new Adder("adder");
    const env = { ...singleConsumer, ...actorSubsys, ...adder };
    const enqueueEnv = {
      id: adder.id,
      queue: { push: actorSubsys.queue.push },
    };

    expect(adder.state).toBeUndefined();
    expect(adder.value).toEqual(0);

    // It is actually same with `post` call without awaiting.
    await enqueue(enqueueEnv, { item: { delta: 1 } });
    expect(adder.state).toBeUndefined();
    expect(adder.value).toEqual(0);

    await post(env, { item: { delta: 1 } });
    expect(adder.state).toBeUndefined();
    expect(adder.value).toEqual(0);

    await post(env, { item: { delta: 1 } });
    expect(adder.state).toBeUndefined();
    expect(adder.value).toEqual(0);

    await tryToProcess(env);
    expect(adder.state).toEqual("committed");
    expect(adder.value).toEqual(3);

    await tryToProcess(env);
    expect(adder.state).toEqual("committed");
    expect(adder.value).toEqual(3);
  });
});

describe("enqueue", () => {
  it("fills default metadata and keeps a provided messageId", async () => {
    const queue = createInMemoryQueue();
    const env = { id: "meta", queue };

    const generated = await enqueue(env, { item: { delta: 1 } });
    expect(generated.messageId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(generated.awaitPolicy).toEqual(0);
    expect(generated.awaitTimeoutMillis).toEqual(0);

    const explicit = await enqueue(env, {
      item: { delta: 2 },
      messageId: "my-id",
      awaitTimeoutMillis: 1234,
    });
    expect(explicit.messageId).toEqual("my-id");
    expect(explicit.awaitTimeoutMillis).toEqual(1234);

    // An empty messageId is regenerated, matching legacy `||` semantics.
    const regenerated = await enqueue(env, {
      item: { delta: 3 },
      messageId: "",
    });
    expect(regenerated.messageId).not.toEqual("");

    expect(await queue.size("meta")).toEqual(3);
  });
});
