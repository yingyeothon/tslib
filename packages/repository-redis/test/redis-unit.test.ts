import type { Codec } from "@yingyeothon/codec";
import type { Logger } from "@yingyeothon/logger";
import type { RedisConnection } from "@yingyeothon/naive-redis";
import { createListDocument, createMapDocument } from "@yingyeothon/repository";
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

    await repo.set("key1", { hello: "world" });
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

    await repo.set("key1", 42);
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

    await repo.set("key1", "value");
    await repo.set("key1", undefined);
    expect(fake.store.size).toEqual(0);

    await repo.set("key2", "value");
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

    await repo.set("key1", { hello: "world" });
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

    await prefixed.set("key1", "value");
    expect(fake.store.has("repo:nested:key1")).toEqual(true);
    expect(await repo.get("key1")).toBeUndefined();
  });

  it("backs versioned documents from @yingyeothon/repository", async () => {
    const fake = fakeRedis();
    const repo = createRedisRepository({ redisConnection: fake.connection });

    const mapDoc = createMapDocument<string>({
      repository: repo,
      key: "map-doc",
    });
    await mapDoc.insertOrUpdate("hello", "world");
    const map = await mapDoc.read();
    expect(map.version).toEqual(1);
    expect(map.content).toEqual({ hello: "world" });

    const listDoc = createListDocument<string>({
      repository: repo,
      key: "list-doc",
    });
    await listDoc.insert("hello");
    const list = await listDoc.read();
    expect(list.version).toEqual(1);
    expect(list.content).toEqual(["hello"]);
  });
});
