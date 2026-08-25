import {
  AwaitPolicy,
  post,
  send,
  singleConsumer,
  tryToProcess,
} from "@yingyeothon/actor-system";
import { expect } from "vitest";
import { createRedisSubsystem } from "../src/index.js";
import { fixture } from "./fixture.js";

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

fixture("adder-await", async (connection) => {
  const adder = new Adder("adder");
  const env = {
    ...singleConsumer,
    ...createRedisSubsystem({
      connection,
      keyPrefix: "__TEST__await__",
      lockTimeout: 30_000,
    }),
    ...adder,
  };

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

  const orderSet: string[] = [];
  setTimeout(() => {
    orderSet.push("first");
    void tryToProcess(env, { oneShot: true });
  }, 50);

  const wait = await post(env, {
    item: { delta: 1 },
    awaitPolicy: AwaitPolicy.Commit,
    awaitTimeoutMillis: 1000,
  });
  expect(wait).toBe(true);

  orderSet.push("second");
  expect(adder.state).toEqual("committed");
  expect(adder.value).toEqual(3);
  expect(orderSet).toEqual(["first", "second"]);
});
