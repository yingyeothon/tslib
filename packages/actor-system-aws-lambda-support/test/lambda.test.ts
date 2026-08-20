import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { ActorProcessEnvironment } from "@yingyeothon/actor-system";
import {
  enqueue,
  InMemoryAwaiter,
  InMemoryLock,
  InMemoryQueue,
  singleConsumer,
} from "@yingyeothon/actor-system";
import type { Callback, Context } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  globalTimeline,
  handleActorLambdaEvent,
  shiftToNextLambda,
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

function newActorSubsys() {
  return {
    queue: new InMemoryQueue(),
    lock: new InMemoryLock(),
    awaiter: new InMemoryAwaiter(),
  };
}

const context = {} as unknown as Context;

function decodePayload(payload: unknown): unknown {
  return JSON.parse(Buffer.from(payload as Uint8Array).toString("utf-8"));
}
const callback = (() => undefined) as Callback;

const lambdaMock = mockClient(LambdaClient);

beforeEach(() => {
  lambdaMock.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("handleActorLambdaEvent", () => {
  it("processes queued messages for the requested actor", async () => {
    const actorSubsys = newActorSubsys();
    const adder = new Adder("adder");
    const enqueueEnv = {
      id: adder.id,
      queue: { push: actorSubsys.queue.push },
    };
    const handle = handleActorLambdaEvent<AdderMessage>({
      newActorEnv: () => ({ ...singleConsumer, ...actorSubsys, ...adder }),
    });

    await enqueue(enqueueEnv, { item: { delta: 1 } });
    await enqueue(enqueueEnv, { item: { delta: 2 } });
    await enqueue(enqueueEnv, { item: { delta: 3 } });
    await enqueue(enqueueEnv, { item: { delta: 4 } });

    await handle({ actorId: adder.id }, context, callback);
    expect(adder.value).toEqual(10);

    await enqueue(enqueueEnv, { item: { delta: 5 } });

    await handle({ actorId: adder.id }, context, callback);
    expect(adder.value).toEqual(15);
    expect(adder.state).toEqual("committed");
  });

  it("resets the global timeline with the default lifetime", async () => {
    const actorSubsys = newActorSubsys();
    const adder = new Adder("adder");
    const handle = handleActorLambdaEvent<AdderMessage>({
      newActorEnv: () => ({ ...singleConsumer, ...actorSubsys, ...adder }),
    });

    await handle({ actorId: adder.id }, context, callback);
    expect(globalTimeline.timeoutMillis).toEqual(870 * 1000);
  });

  it("resets the global timeline with processOptions.aliveMillis", async () => {
    const actorSubsys = newActorSubsys();
    const adder = new Adder("adder");
    const logs: string[] = [];
    const handle = handleActorLambdaEvent<AdderMessage>({
      newActorEnv: () => ({ ...singleConsumer, ...actorSubsys, ...adder }),
      logger: {
        debug: (...args: unknown[]) => logs.push(args.join(" ")),
        info: () => undefined,
        error: () => undefined,
      },
      processOptions: { aliveMillis: 1234, oneShot: true, shiftable: false },
    });

    await handle({ actorId: adder.id }, context, callback);
    expect(globalTimeline.timeoutMillis).toEqual(1234);
    expect(logs.length).toBeGreaterThan(0);
  });

  it("throws when newActorEnv returns nothing", async () => {
    const handle = handleActorLambdaEvent<AdderMessage>({
      newActorEnv: () =>
        undefined as unknown as ActorProcessEnvironment<AdderMessage>,
    });

    await expect(
      handle({ actorId: "nobody" }, context, callback),
    ).rejects.toThrow("No actor env");
  });

  it("shifts remaining work to the next lambda when the lifetime is over", async () => {
    vi.useFakeTimers();
    lambdaMock.on(InvokeCommand).resolves({ StatusCode: 202 });

    const actorSubsys = newActorSubsys();
    const adder = new Adder("adder");
    const enqueueEnv = {
      id: adder.id,
      queue: { push: actorSubsys.queue.push },
    };
    const slowAdder = {
      ...adder,
      onMessage: ({ delta }: AdderMessage): void => {
        adder.value += delta;
        // Simulate a message that consumes the whole remaining lifetime.
        vi.advanceTimersByTime(200);
      },
    };
    const handle = handleActorLambdaEvent<AdderMessage>({
      newActorEnv: () => ({
        ...singleConsumer,
        ...actorSubsys,
        ...slowAdder,
        shift: shiftToNextLambda({ functionName: "next-actor" }),
      }),
      processOptions: { aliveMillis: 100, oneShot: true, shiftable: true },
    });

    await enqueue(enqueueEnv, { item: { delta: 1 } });
    await enqueue(enqueueEnv, { item: { delta: 2 } });

    await handle({ actorId: adder.id }, context, callback);

    // Only the first message fit into the lifetime; the rest was shifted.
    expect(adder.value).toEqual(1);
    expect(await actorSubsys.queue.size(adder.id)).toEqual(1);

    const calls = lambdaMock.commandCalls(InvokeCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.FunctionName).toEqual("next-actor");
    expect(input.InvocationType).toEqual("Event");
    expect(input.Qualifier).toEqual("$LATEST");
    expect(decodePayload(input.Payload)).toEqual({
      actorId: "adder",
    });
  });
});

describe("shiftToNextLambda", () => {
  it("invokes the target function with the default payload and qualifier", async () => {
    lambdaMock.on(InvokeCommand).resolves({ StatusCode: 202 });
    const shift = shiftToNextLambda({ functionName: "my-function" });

    await shift("actor-1");

    const calls = lambdaMock.commandCalls(InvokeCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.FunctionName).toEqual("my-function");
    expect(input.InvocationType).toEqual("Event");
    expect(input.Qualifier).toEqual("$LATEST");
    expect(decodePayload(input.Payload)).toEqual({
      actorId: "actor-1",
    });
  });

  it("uses the given function version and payload builder", async () => {
    lambdaMock.on(InvokeCommand).resolves({ StatusCode: 202 });
    const shift = shiftToNextLambda({
      functionName: "my-function",
      functionVersion: "7",
      buildPayload: (actorId) => ({ id: actorId, kind: "shift" }),
    });

    await shift("actor-2");

    const input = lambdaMock.commandCalls(InvokeCommand)[0]!.args[0].input;
    expect(input.Qualifier).toEqual("7");
    expect(decodePayload(input.Payload)).toEqual({
      id: "actor-2",
      kind: "shift",
    });
  });

  it("propagates invocation errors", async () => {
    lambdaMock.on(InvokeCommand).rejects(new Error("lambda is down"));
    const shift = shiftToNextLambda({ functionName: "my-function" });

    await expect(shift("actor-3")).rejects.toThrow("lambda is down");
  });
});
