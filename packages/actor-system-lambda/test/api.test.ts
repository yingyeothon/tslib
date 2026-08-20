import type { ActorSendOptions } from "@yingyeothon/actor-system";
import {
  AwaitPolicy,
  enqueue,
  createInMemoryAwaiter,
  createInMemoryLock,
  createInMemoryQueue,
  singleConsumer,
} from "@yingyeothon/actor-system";
import type { APIGatewayProxyEvent, Callback, Context } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { createActorAPIEventHandler } from "../src/index.js";

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

function newActorSubsys() {
  return {
    queue: createInMemoryQueue(),
    lock: createInMemoryLock(),
    awaiter: createInMemoryAwaiter(),
  };
}

const context = {} as unknown as Context;
const callback = (() => undefined) as Callback;

function apiEvent(body: string | null): APIGatewayProxyEvent {
  return { path: "/actor-id", body } as APIGatewayProxyEvent;
}

describe("createActorAPIEventHandler", () => {
  it("processes queued messages inline with the send policy", async () => {
    const actorSubsys = newActorSubsys();
    const adder = new Adder("adder");
    const enqueueEnv = {
      id: adder.id,
      queue: { push: actorSubsys.queue.push },
    };
    const handle = createActorAPIEventHandler<AdderMessage>({
      newActorEnv: () => ({ ...singleConsumer, ...actorSubsys, ...adder }),
      policy: { type: "send" },
    });

    await enqueue(enqueueEnv, { item: { delta: 1 } });
    await enqueue(enqueueEnv, { item: { delta: 2 } });
    await enqueue(enqueueEnv, { item: { delta: 3 } });
    await enqueue(enqueueEnv, { item: { delta: 4 } });

    const response = await handle(
      apiEvent(JSON.stringify({ delta: 32 })),
      context,
      callback,
    );
    // "send" can process messages in the queue.
    expect(adder.value).toEqual(42);
    expect(response).toEqual({ statusCode: 200, body: "OK" });

    await enqueue(enqueueEnv, { item: { delta: 5 } });

    await handle(apiEvent(JSON.stringify({ delta: 5 })), context, callback);
    expect(adder.value).toEqual(52);
    expect(adder.state).toEqual("committed");
  });

  it("honors explicit processOptions with the send policy", async () => {
    const actorSubsys = newActorSubsys();
    const adder = new Adder("adder");
    const handle = createActorAPIEventHandler<AdderMessage>({
      newActorEnv: () => ({ ...singleConsumer, ...actorSubsys, ...adder }),
      policy: {
        type: "send",
        processOptions: { aliveMillis: 1000, oneShot: true, shiftable: false },
        messageMeta: { awaitPolicy: AwaitPolicy.Commit },
      },
    });

    await handle(apiEvent(JSON.stringify({ delta: 7 })), context, callback);
    expect(adder.value).toEqual(7);
  });

  it("only enqueues the message with the post policy", async () => {
    const actorSubsys = newActorSubsys();
    const adder = new Adder("adder");
    const enqueueEnv = {
      id: adder.id,
      queue: { push: actorSubsys.queue.push },
    };
    const handle = createActorAPIEventHandler<AdderMessage>({
      newActorEnv: () => ({ ...singleConsumer, ...actorSubsys, ...adder }),
      policy: { type: "post" },
    });

    await enqueue(enqueueEnv, { item: { delta: 1 } });
    await enqueue(enqueueEnv, { item: { delta: 2 } });
    await enqueue(enqueueEnv, { item: { delta: 3 } });
    await enqueue(enqueueEnv, { item: { delta: 4 } });

    const response = await handle(
      apiEvent(JSON.stringify({ delta: 32 })),
      context,
      callback,
    );
    // "post" does not process messages in the queue.
    expect(adder.value).toEqual(0);
    expect(response).toEqual({ statusCode: 200, body: "OK" });
    expect(await actorSubsys.queue.size(adder.id)).toEqual(5);
  });

  it("uses a custom parseMessage and logger", async () => {
    const logs: string[] = [];
    const logger = {
      severity: "debug" as const,
      debug: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
      info: () => undefined,
      warn: () => undefined,
      error: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    };
    const actorSubsys = newActorSubsys();
    const adder = new Adder("adder");
    const handle = createActorAPIEventHandler<AdderMessage>({
      newActorEnv: () => ({ ...singleConsumer, ...actorSubsys, ...adder }),
      parseMessage: (body) => ({ delta: Number(body) }),
      logger,
      policy: { type: "send" },
    });

    await handle(apiEvent("11"), context, callback);
    expect(adder.value).toEqual(11);
    expect(logs.length).toBeGreaterThan(0);
  });

  it("throws when newActorEnv returns nothing", async () => {
    const handle = createActorAPIEventHandler<AdderMessage>({
      newActorEnv: () => undefined as unknown as ActorSendOptions<AdderMessage>,
      policy: { type: "send" },
    });

    await expect(
      handle(apiEvent(JSON.stringify({ delta: 1 })), context, callback),
    ).rejects.toThrow("No actor env for [/actor-id]");
  });

  it("throws when the request has no body", async () => {
    const actorSubsys = newActorSubsys();
    const adder = new Adder("adder");
    const handle = createActorAPIEventHandler<AdderMessage>({
      newActorEnv: () => ({ ...singleConsumer, ...actorSubsys, ...adder }),
      policy: { type: "post" },
    });

    await expect(handle(apiEvent(null), context, callback)).rejects.toThrow(
      "No message body for [/actor-id]",
    );
  });

  it("throws when the parsed message is falsy", async () => {
    const actorSubsys = newActorSubsys();
    const adder = new Adder("adder");
    const handle = createActorAPIEventHandler<AdderMessage>({
      newActorEnv: () => ({ ...singleConsumer, ...actorSubsys, ...adder }),
      policy: { type: "send" },
    });

    await expect(handle(apiEvent("null"), context, callback)).rejects.toThrow(
      "Invalid message for actor[adder]",
    );
    expect(adder.value).toEqual(0);
  });
});
