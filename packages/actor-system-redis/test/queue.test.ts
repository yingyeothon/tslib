import { expect } from "vitest";
import { createRedisQueue } from "../src/index.js";
import { fixture } from "./fixture.js";

interface KeyValue {
  key: string;
  value: string;
}

fixture("queue push/peek/pop/size", async (connection) => {
  const queue = createRedisQueue({ connection, ttlSeconds: 60 });
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
  const queue = createRedisQueue({
    connection,
    keyPrefix: "flush:",
    ttlSeconds: 60,
  });
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
    const queueA = createRedisQueue({
      connection,
      keyPrefix: "a:",
      ttlSeconds: 60,
    });
    const queueB = createRedisQueue({
      connection,
      keyPrefix: "b:",
      ttlSeconds: 60,
    });
    const actorId = "same-actor";

    await queueA.push(actorId, "only-a");
    expect(await queueA.size(actorId)).toBe(1);
    expect(await queueB.size(actorId)).toBe(0);
    expect(await queueB.pop(actorId)).toBe(null);
    expect(await queueA.pop(actorId)).toBe("only-a");
  },
);

fixture("push reports the queue depth", async (connection) => {
  const queue = createRedisQueue({
    connection,
    keyPrefix: "depth:",
    ttlSeconds: 60,
  });
  const actorId = "test-actor";

  expect(await queue.push(actorId, { seq: 1 })).toBe(1);
  expect(await queue.push(actorId, { seq: 2 })).toBe(2);
  expect(await queue.push(actorId, { seq: 3 })).toBe(3);

  await queue.flush(actorId);
  expect(await queue.push(actorId, { seq: 4 })).toBe(1);
});

fixture("ttlSeconds is re-applied on every push", async (connection) => {
  const queue = createRedisQueue({
    connection,
    keyPrefix: "ttl:",
    ttlSeconds: 1,
  });
  const actorId = "refreshed";

  await queue.push(actorId, { seq: 1 });
  // Most of the first TTL elapses, then a second push must reset it.
  await new Promise((resolve) => setTimeout(resolve, 700));
  await queue.push(actorId, { seq: 2 });

  // Past the first TTL's deadline; only a re-applied TTL keeps this alive.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(await queue.size(actorId)).toBe(2);

  // And it still expires once the pushes stop.
  await new Promise((resolve) => setTimeout(resolve, 800));
  expect(await queue.size(actorId)).toBe(0);
});

fixture("an unconsumed queue expires on its own", async (connection) => {
  const queue = createRedisQueue({
    connection,
    keyPrefix: "abandoned:",
    ttlSeconds: 1,
  });
  const actorId = "abandoned";

  await queue.push(actorId, { seq: 1 });
  expect(await queue.size(actorId)).toBe(1);

  await new Promise((resolve) => setTimeout(resolve, 1300));
  expect(await queue.size(actorId)).toBe(0);
});

fixture("never logs the queued payload", async (connection) => {
  const lines: string[] = [];
  const logger = {
    severity: "debug" as const,
    debug: (...args: unknown[]) => lines.push(flatten(args)),
    info: (...args: unknown[]) => lines.push(flatten(args)),
    warn: (...args: unknown[]) => lines.push(flatten(args)),
    error: (...args: unknown[]) => lines.push(flatten(args)),
  };
  const queue = createRedisQueue({
    connection,
    keyPrefix: "quiet:",
    logger,
    ttlSeconds: 60,
  });
  const actorId = "logging";
  const secret = "PAYLOAD-ALPHA-9f2";

  await queue.push(actorId, { text: secret });
  await queue.peek(actorId);
  await queue.flush(actorId);

  const text = lines.join("\n");
  // Positive control: the queue did log, so the absence below means
  // something.
  expect(text).toContain("quiet:logging");
  expect(text).not.toContain(secret);
  expect(text).not.toContain("ALPHA");
});

function flatten(args: unknown[]): string {
  return args
    .map((arg) =>
      typeof arg === "string"
        ? arg
        : Object.entries(arg as Record<string, unknown>)
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(" "),
    )
    .join(" ");
}
