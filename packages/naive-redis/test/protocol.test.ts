import type { NaiveSocket } from "@yingyeothon/naive-socket";
import { describe, expect, it } from "vitest";
import type { RedisConnection } from "../src/index.js";
import {
  redisDel,
  redisExists,
  redisGet,
  redisIncr,
  redisLindex,
  redisLlen,
  redisLpop,
  redisLrange,
  redisLtrim,
  redisRpush,
  redisSadd,
  redisSend,
  redisSet,
  redisSimpleWork,
  redisSmembers,
  redisSrem,
} from "../src/index.js";
import { ensureValue } from "../src/exchange/ensureValue.js";
import { serializeCommand } from "../src/set.js";

interface FakeConnection {
  connection: RedisConnection;
  sent: string[];
}

function fakeConnection(respond: (message: string) => string): FakeConnection {
  const sent: string[] = [];
  const socket = {
    send: ({ message }: { message: string }): Promise<string> => {
      sent.push(message);
      return Promise.resolve(respond(message));
    },
  } as unknown as NaiveSocket;
  return { connection: { socket, timeoutMillis: 1000 }, sent };
}

describe("serializeCommand", () => {
  it("joins short commands without quotes inline", () => {
    expect(serializeCommand(["SET", "key", "value"])).toBe("SET key value");
  });

  it("uses the RESP array form when a part contains a quote", () => {
    expect(serializeCommand(["SET", "key", 'va"lue'])).toBe(
      '*3\r\n$3\r\nSET\r\n$3\r\nkey\r\n$6\r\nva"lue\r\n',
    );
  });

  it("uses the RESP array form for oversized commands", () => {
    const big = "x".repeat((1 << 16) + 1);
    expect(serializeCommand(["SET", "key", big])).toBe(
      `*3\r\n$3\r\nSET\r\n$3\r\nkey\r\n$${big.length}\r\n${big}\r\n`,
    );
  });
});

describe("ensureValue", () => {
  it("throws on an empty response", () => {
    expect(() => ensureValue([], 0, /\+(OK)/)).toThrow("empty response");
  });

  it("throws on an error response", () => {
    expect(() => ensureValue(["-ERR oops"], 0, /\+(OK)/)).toThrow(
      "Error: -ERR oops",
    );
  });

  it("throws when the response does not match", () => {
    expect(() => ensureValue([":42"], 0, /\+(OK)/)).toThrow("Not expected");
  });

  it("returns the captured group", () => {
    expect(ensureValue(["+OK"], 0, /\+(OK)/)).toBe("OK");
  });
});

describe("redisSend", () => {
  it("awaits a successful authentication before sending", async () => {
    const { connection, sent } = fakeConnection(() => "+OK\r\n");
    connection.authenticated = Promise.resolve(true);
    await expect(redisLtrim(connection, "q", 1)).resolves.toBe(true);
    expect(sent).toEqual(['LTRIM "q" 1 -1\r\n']);
  });

  it("fails fast when authentication failed", async () => {
    const { connection, sent } = fakeConnection(() => "+OK\r\n");
    connection.authenticated = Promise.resolve(false);
    await expect(redisGet(connection, "key")).rejects.toThrow(
      "Invalid password",
    );
    expect(sent).toEqual([]);
  });
});

describe("command serialization and reply parsing", () => {
  it("parses a GET reply", async () => {
    const { connection, sent } = fakeConnection(() => "$5\r\nhello\r\n");
    await expect(redisGet(connection, "key")).resolves.toBe("hello");
    expect(sent).toEqual(['GET "key"\r\n']);
  });

  it("parses a GET miss", async () => {
    const { connection } = fakeConnection(() => "$-1\r\n");
    await expect(redisGet(connection, "key")).resolves.toBeNull();
  });

  it("rejects on a GET error reply", async () => {
    const { connection } = fakeConnection(() => "-ERR broken\r\n");
    await expect(redisGet(connection, "key")).rejects.toThrow(
      "Error: -ERR broken",
    );
  });

  it("serializes SET with expiration and NX and parses +OK", async () => {
    const { connection, sent } = fakeConnection(() => "+OK\r\n");
    await expect(
      redisSet(connection, "key", "value", {
        expirationMillis: 1500,
        onlySet: "nx",
      }),
    ).resolves.toBe(true);
    expect(sent).toEqual(["SET key value PX 1500 NX\r\n"]);
  });

  it("returns false when SET NX does not apply", async () => {
    const { connection } = fakeConnection(() => "$-1\r\n");
    await expect(
      redisSet(connection, "key", "value", { onlySet: "nx" }),
    ).resolves.toBe(false);
  });

  it("serializes multi-key DEL and EXISTS with counts", async () => {
    const { connection, sent } = fakeConnection(() => ":2\r\n");
    await expect(redisDel(connection, "a", "b")).resolves.toBe(2);
    await expect(redisExists(connection, "a", "b")).resolves.toBe(2);
    expect(sent).toEqual(['DEL "a" "b"\r\n', 'EXISTS "a" "b"\r\n']);
  });

  it("rejects when a count reply is not numeric", async () => {
    const { connection } = fakeConnection(() => "+OK\r\n");
    await expect(redisIncr(connection, "key")).rejects.toThrow("Not expected");
  });

  it("serializes list commands", async () => {
    const { connection, sent } = fakeConnection((message) =>
      message.startsWith("LPOP") || message.startsWith("LINDEX")
        ? "$1\r\na\r\n"
        : ":1\r\n",
    );
    await expect(redisRpush(connection, "q", "a", "b")).resolves.toBe(1);
    await expect(redisLlen(connection, "q")).resolves.toBe(1);
    await expect(redisLpop(connection, "q")).resolves.toBe("a");
    await expect(redisLindex(connection, "q", 3)).resolves.toBe("a");
    expect(sent).toEqual([
      'RPUSH "q" "a" "b"\r\n',
      'LLEN "q"\r\n',
      'LPOP "q"\r\n',
      'LINDEX "q" 3\r\n',
    ]);
  });

  it("parses a multi-bulk reply", async () => {
    const { connection, sent } = fakeConnection(
      () => "*2\r\n$1\r\na\r\n$3\r\nabc\r\n",
    );
    await expect(redisLrange(connection, "q", 0)).resolves.toEqual([
      "a",
      "abc",
    ]);
    expect(sent).toEqual(['LRANGE "q" 0 -1\r\n']);
  });

  it("parses an empty multi-bulk reply", async () => {
    const { connection } = fakeConnection(() => "*0\r\n");
    await expect(redisSmembers(connection, "s")).resolves.toEqual([]);
  });

  it("rejects on a multi-bulk error reply", async () => {
    const { connection } = fakeConnection(() => "-ERR wrong type\r\n");
    await expect(redisLrange(connection, "q", 0)).rejects.toThrow(
      "Error: -ERR wrong type",
    );
  });

  it("rejects on a mismatched multi-bulk length", async () => {
    const { connection } = fakeConnection(() => "*1\r\n");
    await expect(redisSmembers(connection, "s")).rejects.toThrow(
      "mismatch length",
    );
  });

  it("serializes set commands with JSON escaped values", async () => {
    const { connection, sent } = fakeConnection(() => ":1\r\n");
    await expect(redisSadd(connection, "s", 'a"b')).resolves.toBe(1);
    await expect(redisSrem(connection, "s", "a\\b")).resolves.toBe(1);
    expect(sent).toEqual(['SADD "s" "a\\"b"\r\n', 'SREM "s" "a\\\\b"\r\n']);
  });

  it("exposes raw exchanges through redisSend", async () => {
    const { connection, sent } = fakeConnection(() => "+PONG\r\n");
    await expect(
      redisSend({
        connection,
        commands: ["PING"],
        match: (m) => m.capture("\r\n"),
        transform: (result) => result[0],
      }),
    ).resolves.toBe("+PONG");
    expect(sent).toEqual(["PING\r\n"]);
  });
});

describe("redisSimpleWork", () => {
  it("disconnects the socket even when the work fails", async () => {
    await expect(
      redisSimpleWork({ host: "localhost", port: 65535 }, () =>
        Promise.reject(new Error("boom")),
      ),
    ).rejects.toThrow("boom");
  });
});
