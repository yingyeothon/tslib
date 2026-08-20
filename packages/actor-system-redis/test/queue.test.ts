import { expect } from "vitest";
import { createRedisQueue } from "../src/index.js";
import { fixture } from "./fixture.js";

interface KeyValue {
  key: string;
  value: string;
}

fixture("queue push/peek/pop/size", async (connection) => {
  const queue = createRedisQueue({ connection });
  const actorId = "test-actor";

  expect(await queue.size(actorId)).toBe(0);
  expect(await queue.peek(actorId)).toBe(null);
  expect(await queue.pop(actorId)).toBe(null);

  const tuple1: KeyValue = { key: "hello", value: "world" };
  const tuple2: KeyValue = { key: "hi", value: "there" };

  await queue.push(actorId, tuple1);
  expect(await queue.size(actorId)).toBe(1);
  expect(await queue.peek(actorId)).toEqual(tuple1);

  await queue.push(actorId, tuple2);
  expect(await queue.size(actorId)).toBe(2);
  expect(await queue.peek(actorId)).toEqual(tuple1);

  expect(await queue.pop(actorId)).toEqual(tuple1);
  expect(await queue.size(actorId)).toBe(1);
  expect(await queue.peek(actorId)).toEqual(tuple2);

  expect(await queue.pop(actorId)).toEqual(tuple2);
  expect(await queue.size(actorId)).toBe(0);
  expect(await queue.peek(actorId)).toBe(null);
});

fixture("queue flush drains all pending items at once", async (connection) => {
  const queue = createRedisQueue({ connection, keyPrefix: "flush:" });
  const actorId = "test-actor";

  expect(await queue.flush(actorId)).toEqual([]);

  await queue.push(actorId, { seq: 1 });
  await queue.push(actorId, { seq: 2 });
  await queue.push(actorId, { seq: 3 });
  expect(await queue.size(actorId)).toBe(3);

  expect(await queue.flush(actorId)).toEqual([
    { seq: 1 },
    { seq: 2 },
    { seq: 3 },
  ]);
  expect(await queue.size(actorId)).toBe(0);
  expect(await queue.flush(actorId)).toEqual([]);
});

fixture(
  "queues with different key prefixes are isolated",
  async (connection) => {
    const queueA = createRedisQueue({ connection, keyPrefix: "a:" });
    const queueB = createRedisQueue({ connection, keyPrefix: "b:" });
    const actorId = "same-actor";

    await queueA.push(actorId, "only-a");
    expect(await queueA.size(actorId)).toBe(1);
    expect(await queueB.size(actorId)).toBe(0);
    expect(await queueB.pop(actorId)).toBe(null);
    expect(await queueA.pop(actorId)).toBe("only-a");
  },
);
