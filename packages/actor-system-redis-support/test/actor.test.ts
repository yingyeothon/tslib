import { post, singleConsumer, tryToProcess } from "@yingyeothon/actor-system";
import { expect } from "vitest";
import { newRedisSubsystem } from "../src/index.js";
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

fixture("simple-actor", async (connection) => {
  const adder = new Adder("adder");
  const env = {
    ...singleConsumer,
    ...newRedisSubsystem({ connection, keyPrefix: "__TEST__simple__" }),
    ...adder,
  };

  expect(adder.state).toBeUndefined();
  expect(adder.value).toEqual(0);

  await post(env, { item: { delta: 1 } });
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
});
