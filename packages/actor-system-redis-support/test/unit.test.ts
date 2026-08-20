import type { RedisConnection } from "@yingyeothon/naive-redis";
import { describe, expect, it } from "vitest";
import { newRedisSubsystem, RedisAwaiter, RedisQueue } from "../src/index.js";

interface FakeRedis {
  connection: RedisConnection;
  messages: string[];
}

/**
 * Builds a connection whose socket answers each `send` with the next
 * scripted RESP response, recording every sent message. A response can
 * also be an `Error` to simulate a broken connection.
 */
function fakeRedis(responses: Array<string | Error>): FakeRedis {
  const messages: string[] = [];
  let cursor = 0;
  const socket = {
    send: ({ message }: { message: string }): Promise<string> => {
      messages.push(message);
      const response = responses[Math.min(cursor++, responses.length - 1)];
      if (response === undefined || response instanceof Error) {
        return Promise.reject(response ?? new Error("no scripted response"));
      }
      return Promise.resolve(response);
    },
  };
  return {
    connection: { socket, timeoutMillis: 1000 } as unknown as RedisConnection,
    messages,
  };
}

describe("RedisAwaiter with a fake connection", () => {
  it("returns false immediately when timeoutMillis <= 0", async () => {
    const { connection, messages } = fakeRedis([new Error("must not touch")]);
    const awaiter = new RedisAwaiter({ connection });

    expect(await awaiter.wait("actor", "message", 0)).toBe(false);
    expect(await awaiter.wait("actor", "message", -1)).toBe(false);
    expect(messages).toEqual([]);
  });

  it("polls until the message is resolved", async () => {
    const { connection, messages } = fakeRedis([
      "$-1\r\n",
      "$-1\r\n",
      "$1\r\n1\r\n",
    ]);
    const awaiter = new RedisAwaiter({ connection, keyPrefix: "p:" });

    expect(await awaiter.wait("actor", "message", 10_000)).toBe(true);
    expect(messages).toHaveLength(3);
    expect(messages[0]).toContain('GET "p:actor/message"');
  });

  it("propagates redis errors from wait", async () => {
    const { connection } = fakeRedis([new Error("connection reset")]);
    const awaiter = new RedisAwaiter({ connection });

    await expect(awaiter.wait("actor", "message", 1000)).rejects.toThrow(
      "connection reset",
    );
  });

  it("resolve sets a short-lived key", async () => {
    const { connection, messages } = fakeRedis(["+OK\r\n"]);
    const logs: unknown[][] = [];
    const logger = {
      debug: (...args: unknown[]) => logs.push(args),
      info: () => undefined,
      error: () => undefined,
    };
    const awaiter = new RedisAwaiter({ connection, keyPrefix: "p:", logger });

    await awaiter.resolve("actor", "message");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("SET p:actor/message 1 PX 1000");
    expect(logs).toContainEqual([
      "redis-awaiter",
      "resolve",
      "p:actor/message",
      true,
    ]);
  });

  it("resolve swallows redis errors but logs them", async () => {
    const error = new Error("connection reset");
    const { connection } = fakeRedis([error]);
    const logs: unknown[][] = [];
    const logger = {
      debug: (...args: unknown[]) => logs.push(args),
      info: () => undefined,
      error: () => undefined,
    };
    const awaiter = new RedisAwaiter({ connection, logger });

    await expect(awaiter.resolve("actor", "message")).resolves.toBeUndefined();
    expect(logs).toContainEqual([
      "redis-awaiter",
      "resolve",
      "actor/message",
      "error",
      error,
    ]);
  });
});

describe("newRedisSubsystem", () => {
  it("prefixes queue, lock, and awaiter keys under the given prefix", async () => {
    const { connection, messages } = fakeRedis([
      ":0\r\n", // LLEN
      "+OK\r\n", // SET NX (lock)
      "+OK\r\n", // SET PX (awaiter resolve)
    ]);
    const subsystem = newRedisSubsystem({ connection, keyPrefix: "app:" });

    expect(await subsystem.queue.size("actor")).toBe(0);
    expect(await subsystem.lock.tryAcquire("actor")).toBe(true);
    await subsystem.awaiter.resolve("actor", "message");

    expect(messages[0]).toContain('LLEN "app:queue:actor"');
    expect(messages[1]).toContain("SET app:lock:actor 1 NX");
    expect(messages[2]).toContain("SET app:awaiter:actor/message 1 PX 1000");
  });

  it("spreads into an actor environment as own properties", () => {
    const { connection } = fakeRedis([]);
    const spread = { ...newRedisSubsystem({ connection }) };
    expect(spread.queue).toBeInstanceOf(RedisQueue);
    expect(Object.keys({ ...spread.queue })).toEqual(
      expect.arrayContaining(["size", "push", "pop", "peek", "flush"]),
    );
  });
});

describe("RedisQueue with a fake connection", () => {
  it("uses a custom codec for push and pop", async () => {
    const codec = {
      encode: <T>(item: T): string => `<${String(item)}>`,
      decode: <T>(value: string): T => value.slice(1, -1) as T,
    };
    const { connection, messages } = fakeRedis([
      ":1\r\n", // RPUSH
      "$5\r\n<abc>\r\n", // LPOP
      "$5\r\n<abc>\r\n", // LINDEX
    ]);
    const queue = new RedisQueue({ connection, codec });

    await queue.push("actor", "abc");
    expect(messages[0]).toContain('RPUSH "actor" "<abc>"');
    expect(await queue.pop("actor")).toBe("abc");
    expect(await queue.peek("actor")).toBe("abc");
  });
});
