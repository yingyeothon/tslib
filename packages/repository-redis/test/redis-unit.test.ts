import type { Codec } from "@yingyeothon/codec";
import type { Logger } from "@yingyeothon/logger";
import type { RedisConnection } from "@yingyeothon/naive-redis";
import { createListDocument, createMapDocument } from "@yingyeothon/repository";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createRedisRepository } from "../src/index.js";

interface FakeRedis {
  connection: RedisConnection;
  store: Map<string, string>;
  sentMessages: string[];
  lastSetExpirationMillis: number | undefined;
}

function parseCommand(message: string): string[] {
  const trimmed = message.replace(/\r\n$/, "");
  if (trimmed.startsWith("*")) {
    // RESP multi-bulk: *N \r\n ($len \r\n value \r\n)*
    const lines = trimmed.split("\r\n");
    return lines.filter((_, index) => index !== 0 && index % 2 === 0);
  }
  // Inline command with optionally double-quoted parts.
  const parts: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  for (const match of trimmed.matchAll(pattern)) {
    parts.push(match[1] ?? match[2] ?? "");
  }
  return parts;
}

function fakeRedis(): FakeRedis {
  const store = new Map<string, string>();
  const sentMessages: string[] = [];
  const fake: FakeRedis = {
    store,
    sentMessages,
    lastSetExpirationMillis: undefined,
    connection: undefined as unknown as RedisConnection,
  };
  const socket = {
    send: ({ message }: { message: string }): Promise<string> => {
      sentMessages.push(message);
      const [command = "", ...args] = parseCommand(message);
      switch (command.toUpperCase()) {
        case "GET": {
          const value = store.get(args[0] ?? "");
          return Promise.resolve(
            value === undefined
              ? "$-1\r\n"
              : `$${value.length}\r\n${value}\r\n`,
          );
        }
        case "SET": {
          const [key = "", value = ""] = args;
          store.set(key, value);
          const pxIndex = args.indexOf("PX");
          fake.lastSetExpirationMillis =
            pxIndex >= 0 ? Number(args[pxIndex + 1]) : undefined;
          return Promise.resolve("+OK\r\n");
        }
        case "DEL": {
          let count = 0;
          for (const key of args) {
            if (store.delete(key)) {
              count += 1;
            }
          }
          return Promise.resolve(`:${count}\r\n`);
        }
        case "EVAL": {
          // [script, numkeys, key, expectedToken, value, px]
          const [, , key = "", expected = "", value = "", px = ""] = args;
          const current = store.get(key);
          const currentToken =
            current === undefined
              ? undefined
              : createHash("sha1").update(current).digest("hex");
          const matches =
            expected === "" ? current === undefined : currentToken === expected;
          if (!matches) {
            return Promise.resolve(":0\r\n");
          }
          store.set(key, value);
          fake.lastSetExpirationMillis = Number(px);
          return Promise.resolve(":1\r\n");
        }
        default:
          return Promise.reject(new Error(`Unsupported command: ${command}`));
      }
    },
    disconnect: (): void => undefined,
  };
  fake.connection = {
    socket: socket,
    timeoutMillis: 1000,
  };
  return fake;
}

describe("createRedisRepository", () => {
  it("stores values under the 'repo:' key layout", async () => {
    const fake = fakeRedis();
    const repo = createRedisRepository({ redisConnection: fake.connection });

    await repo.setWithExpire("key1", { hello: "world" }, 1000);
    expect(fake.store.get("repo:key1")).toEqual(
      JSON.stringify({ hello: "world" }),
    );
    expect(await repo.get<{ hello: string }>("key1")).toEqual({
      hello: "world",
    });
  });

  it("prefixes keys as 'repo:<prefix>:<key>' when a prefix is given", async () => {
    const fake = fakeRedis();
    const repo = createRedisRepository({
      redisConnection: fake.connection,
      prefix: "session",
    });

    await repo.setWithExpire("key1", 42, 1000);
    expect(fake.store.get("repo:session:key1")).toEqual("42");
    expect(await repo.get<number>("key1")).toEqual(42);

    await repo.delete("key1");
    expect(fake.store.size).toEqual(0);
  });

  it("returns undefined for a missing key", async () => {
    const fake = fakeRedis();
    const repo = createRedisRepository({ redisConnection: fake.connection });
    expect(await repo.get("missing")).toBeUndefined();
  });

  it("deletes the key when setting undefined", async () => {
    const fake = fakeRedis();
    const repo = createRedisRepository({ redisConnection: fake.connection });

    await repo.setWithExpire("key1", "value", 1000);
    await repo.set("key1", undefined);
    expect(fake.store.size).toEqual(0);

    await repo.setWithExpire("key2", "value", 1000);
    await repo.setWithExpire("key2", undefined, 1000);
    expect(fake.store.size).toEqual(0);
  });

  it("passes the expiration to redis in setWithExpire", async () => {
    const fake = fakeRedis();
    const repo = createRedisRepository({ redisConnection: fake.connection });

    await repo.setWithExpire("key1", "value", 1234);
    expect(fake.store.has("repo:key1")).toEqual(true);
    expect(fake.lastSetExpirationMillis).toEqual(1234);
  });

  it("throws when expiresInMillis is not positive", async () => {
    const fake = fakeRedis();
    const repo = createRedisRepository({ redisConnection: fake.connection });

    await expect(repo.setWithExpire("key1", "value", 0)).rejects.toThrow(
      '"expiresInMillis" should be greater than 0.',
    );
    await expect(repo.setWithExpire("key1", "value", -1)).rejects.toThrow(
      '"expiresInMillis" should be greater than 0.',
    );
    expect(fake.store.size).toEqual(0);
  });

  it("swallows get errors and logs them via the injected logger", async () => {
    const error = vi.fn();
    const logger: Logger = {
      severity: "error",
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error,
    };
    const broken: RedisConnection = {
      socket: {
        send: () => Promise.reject(new Error("connection lost")),
      } as unknown as RedisConnection["socket"],
      timeoutMillis: 1000,
    };
    const repo = createRedisRepository({ redisConnection: broken, logger });
    expect(await repo.get("key1")).toBeUndefined();
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("failed to read value", {
      key: "key1",
      error: new Error("connection lost"),
    });
  });

  it("swallows get errors silently by default", async () => {
    const broken: RedisConnection = {
      socket: {
        send: () => Promise.reject(new Error("connection lost")),
      } as unknown as RedisConnection["socket"],
      timeoutMillis: 1000,
    };
    const repo = createRedisRepository({ redisConnection: broken });
    expect(await repo.get("key1")).toBeUndefined();
  });

  it("uses a custom codec when given", async () => {
    const fake = fakeRedis();
    const base64Codec: Codec<string> = {
      encode: (value) => Buffer.from(JSON.stringify(value)).toString("base64"),
      decode: <T>(encoded: string) =>
        JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as T,
    };
    const repo = createRedisRepository({
      redisConnection: fake.connection,
      codec: base64Codec,
    });

    await repo.setWithExpire("key1", { hello: "world" }, 1000);
    expect(fake.store.get("repo:key1")).toEqual(
      Buffer.from(JSON.stringify({ hello: "world" })).toString("base64"),
    );
    expect(await repo.get("key1")).toEqual({ hello: "world" });
  });

  it("derives a prefixed repository via withPrefix", async () => {
    const fake = fakeRedis();
    const repo = createRedisRepository({ redisConnection: fake.connection });
    const prefixed = repo.withPrefix("nested");

    expect(prefixed).not.toBe(repo);

    await prefixed.setWithExpire("key1", "value", 1000);
    expect(fake.store.has("repo:nested:key1")).toEqual(true);
    expect(await repo.get("key1")).toBeUndefined();
  });

  it("backs versioned documents from @yingyeothon/repository", async () => {
    const fake = fakeRedis();
    const repo = createRedisRepository({ redisConnection: fake.connection });

    const mapDoc = createMapDocument<string>({
      repository: repo,
      key: "map-doc",
      expiresInMillis: 5000,
    });
    await mapDoc.insertOrUpdate("hello", "world");
    expect(fake.lastSetExpirationMillis).toEqual(5000);
    const map = await mapDoc.read();
    expect(map.version).toEqual(1);
    expect(map.content).toEqual({ hello: "world" });

    const listDoc = createListDocument<string>({
      repository: repo,
      key: "list-doc",
      expiresInMillis: 5000,
    });
    await listDoc.insert("hello");
    const list = await listDoc.read();
    expect(list.version).toEqual(1);
    expect(list.content).toEqual(["hello"]);
  });

  it("rounds a fractional TTL up to whole milliseconds", async () => {
    // Redis rejects `PX 333.33` with "value is not an integer".
    const fake = fakeRedis();
    const repo = createRedisRepository({ redisConnection: fake.connection });
    await repo.setWithExpire("k", "v", 1000 / 3);
    expect(fake.lastSetExpirationMillis).toBe(334);
    const revision = await repo.getRevision("k");
    await repo.compareAndSet("k", revision?.token, "w", {
      expiresInMillis: 1000 / 3,
    });
    expect(fake.lastSetExpirationMillis).toBe(334);
  });

  it("rejects a TTL-less set", async () => {
    const fake = fakeRedis();
    const repo = createRedisRepository({ redisConnection: fake.connection });

    await expect(repo.set("key1", "value")).rejects.toThrow(
      /stores every key with a TTL; use setWithExpire/,
    );
    expect(fake.store.size).toEqual(0);
    expect(fake.sentMessages).toEqual([]);
  });

  it("rejects compareAndSet without a TTL", async () => {
    const fake = fakeRedis();
    const repo = createRedisRepository({ redisConnection: fake.connection });
    const message = /stores every key with a TTL; use setWithExpire/;

    await expect(repo.compareAndSet("key1", undefined, "v")).rejects.toThrow(
      message,
    );
    await expect(
      repo.compareAndSet("key1", undefined, "v", { expiresInMillis: 0 }),
    ).rejects.toThrow(message);
    await expect(
      repo.compareAndSet("key1", undefined, undefined, {
        expiresInMillis: 1000,
      }),
    ).rejects.toThrow("compareAndSet cannot store undefined");
    expect(fake.sentMessages).toEqual([]);
  });

  it("returns a SHA-1 token of the stored string from getRevision", async () => {
    const fake = fakeRedis();
    const repo = createRedisRepository({ redisConnection: fake.connection });

    expect(await repo.getRevision("key1")).toBeUndefined();
    await repo.setWithExpire("key1", { hello: "world" }, 1000);
    const revision = await repo.getRevision<{ hello: string }>("key1");
    expect(revision).toEqual({
      value: { hello: "world" },
      token: createHash("sha1")
        .update(JSON.stringify({ hello: "world" }))
        .digest("hex"),
    });
  });

  it("sends compareAndSet as one EVAL with the key and values as arguments", async () => {
    const fake = fakeRedis();
    const repo = createRedisRepository({
      redisConnection: fake.connection,
      prefix: "p",
    });
    // A value that would break inline framing or a naive script template.
    const value = 'quote\' "double" \r\nFLUSHALL';

    expect(
      await repo.compareAndSet("key1", undefined, value, {
        expiresInMillis: 1234,
      }),
    ).toEqual(true);
    expect(fake.store.get("repo:p:key1")).toEqual(JSON.stringify(value));
    expect(fake.lastSetExpirationMillis).toEqual(1234);

    const [message] = fake.sentMessages;
    expect(message?.startsWith("*")).toEqual(true);
    const [command, script, numKeys, key, expected, stored, px] = parseCommand(
      message ?? "",
    );
    expect(command).toEqual("EVAL");
    expect(numKeys).toEqual("1");
    expect(key).toEqual("repo:p:key1");
    expect(expected).toEqual("");
    expect(stored).toEqual(JSON.stringify(value));
    expect(px).toEqual("1234");
    expect(script).not.toContain("repo:p:key1");
    expect(script).not.toContain("FLUSHALL");
    expect(script).toContain("redis.sha1hex(cur)");

    const token = (await repo.getRevision("key1"))?.token;
    expect(
      await repo.compareAndSet("key1", "stale", "next", {
        expiresInMillis: 10,
      }),
    ).toEqual(false);
    expect(
      await repo.compareAndSet("key1", token, "next", {
        expiresInMillis: 10,
      }),
    ).toEqual(true);
    expect(await repo.get("key1")).toEqual("next");
  });
});
