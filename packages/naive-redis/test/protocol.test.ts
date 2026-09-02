import type { NaiveSocket } from "@yingyeothon/naive-socket";
import { describe, expect, it } from "vitest";
import type { RedisConnection } from "../src/index.js";
import {
  redisDel,
  redisEval,
  redisExists,
  redisExpire,
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

  it("never lets whitespace or CRLF break the inline framing", () => {
    // An injected command must stay inside one length-prefixed argument.
    const evil = "pw\r\nCONFIG SET dir /tmp";
    expect(serializeCommand(["AUTH", evil])).toBe(
      `*2\r\n$4\r\nAUTH\r\n$${evil.length}\r\n${evil}\r\n`,
    );
    expect(serializeCommand(["SET", "key", "two words"])).toBe(
      "*3\r\n$3\r\nSET\r\n$3\r\nkey\r\n$9\r\ntwo words\r\n",
    );
    expect(serializeCommand(["SET", "key", "back\\slash"])).toBe(
      "*3\r\n$3\r\nSET\r\n$3\r\nkey\r\n$10\r\nback\\slash\r\n",
    );
  });

  it("uses byte lengths for multi-byte parts in the RESP array form", () => {
    const value = "한글 값";
    expect(serializeCommand(["SET", "key", value])).toBe(
      `*3\r\n$3\r\nSET\r\n$3\r\nkey\r\n$${Buffer.byteLength(value)}\r\n${value}\r\n`,
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

  it("quotes every inline key argument, including one with whitespace", async () => {
    const { connection, sent } = fakeConnection((message) =>
      message.startsWith("SMEMBERS")
        ? "*0\r\n"
        : message.startsWith("LTRIM")
          ? "+OK\r\n"
          : ":1\r\n",
    );
    await expect(redisIncr(connection, "a b")).resolves.toBe(1);
    await expect(redisSmembers(connection, 'a"b')).resolves.toEqual([]);
    await expect(redisLtrim(connection, "q", 1, 2)).resolves.toBe(true);
    await expect(redisLtrim(connection, "q", 1)).resolves.toBe(true);
    expect(sent).toEqual([
      'INCR "a b"\r\n',
      'SMEMBERS "a\\"b"\r\n',
      'LTRIM "q" 1 2\r\n',
      'LTRIM "q" 1 -1\r\n',
    ]);
  });

  it("keeps the separator before an empty variadic list", async () => {
    const { connection, sent } = fakeConnection(() => ":0\r\n");
    await expect(redisDel(connection)).resolves.toBe(0);
    await expect(redisRpush(connection, "q")).resolves.toBe(0);
    expect(sent).toEqual(["DEL \r\n", 'RPUSH "q" \r\n']);
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

describe("expire and eval framing", () => {
  it("sends EXPIRE through the escaping choke point", async () => {
    const { connection, sent } = fakeConnection(() => ":1\r\n");
    expect(await redisExpire(connection, "queue:game-1", 60)).toBe(true);
    expect(sent[0]).toBe("EXPIRE queue:game-1 60\r\n");
  });

  it("floors a fractional TTL instead of sending a decimal point", async () => {
    const { connection, sent } = fakeConnection(() => ":1\r\n");
    await redisExpire(connection, "k", 1.9);
    expect(sent[0]).toBe("EXPIRE k 1\r\n");
  });

  it("reports a missing key as false", async () => {
    const { connection } = fakeConnection(() => ":0\r\n");
    expect(await redisExpire(connection, "k", 60)).toBe(false);
  });

  it("cannot be used to inject a second command through the key", async () => {
    const { connection, sent } = fakeConnection(() => ":0\r\n");
    await redisExpire(connection, "k\r\nFLUSHALL", 60);
    // The RESP array form is length-prefixed, so the embedded newline is
    // payload rather than a command boundary.
    expect(sent[0]).toBe(
      "*3\r\n$6\r\nEXPIRE\r\n$11\r\nk\r\nFLUSHALL\r\n$2\r\n60\r\n\r\n",
    );
    expect(sent[0]?.startsWith("EXPIRE")).toBe(false);
  });

  it("sends EVAL with NUMKEYS derived from the key list", async () => {
    const { connection, sent } = fakeConnection(() => ":1\r\n");
    expect(
      await redisEval(connection, "return 1", {
        keys: ["lock:a"],
        args: ["token"],
      }),
    ).toBe(1);
    expect(sent[0]).toBe(
      "*5\r\n$4\r\nEVAL\r\n$8\r\nreturn 1\r\n$1\r\n1\r\n$6\r\nlock:a\r\n$5\r\ntoken\r\n\r\n",
    );
  });

  it("defaults to no keys and no args", async () => {
    const { connection, sent } = fakeConnection(() => ":7\r\n");
    expect(await redisEval(connection, "return 7")).toBe(7);
    expect(sent[0]).toBe(
      "*3\r\n$4\r\nEVAL\r\n$8\r\nreturn 7\r\n$1\r\n0\r\n\r\n",
    );
  });

  it("reads a negative integer reply", async () => {
    const { connection } = fakeConnection(() => ":-1\r\n");
    expect(await redisEval(connection, "return -1")).toBe(-1);
  });

  it("rejects a script error instead of returning a number", async () => {
    const { connection } = fakeConnection(() => "-ERR bad script\r\n");
    await expect(redisEval(connection, "boom")).rejects.toThrow(/bad script/);
  });

  it("keeps a multi-line script inside one length-prefixed argument", async () => {
    const { connection, sent } = fakeConnection(() => ":0\r\n");
    const script =
      'if redis.call("GET", KEYS[1]) == ARGV[1] then\n  return 1\nend\nreturn 0';
    await redisEval(connection, script, { keys: ["lock:a"], args: ["t"] });
    const frame = sent[0] ?? "";
    expect(frame.startsWith("*5\r\n$4\r\nEVAL\r\n")).toBe(true);
    expect(frame).toContain(`$${Buffer.byteLength(script)}\r\n${script}\r\n`);
  });
});

describe("quote characters on the inline path", () => {
  it("uses the RESP array form for a single quote", () => {
    // Redis's inline parser treats `'` as a delimiter anywhere in a token,
    // so `SET q v'` is answered with "unbalanced quotes" and the connection
    // is closed under us.
    expect(serializeCommand(["SET", "q", "v'"])).toBe(
      "*3\r\n$3\r\nSET\r\n$1\r\nq\r\n$2\r\nv'\r\n",
    );
  });

  it("does not let two single-quoted arguments merge into one", () => {
    const frame = serializeCommand(["SET", "k'", "v'"]);
    expect(frame.startsWith("SET ")).toBe(false);
    expect(frame).toBe("*3\r\n$3\r\nSET\r\n$2\r\nk'\r\n$2\r\nv'\r\n");
  });

  it("still inlines a quote-free command", () => {
    expect(serializeCommand(["EXPIRE", "queue:g1", "60"])).toBe(
      "EXPIRE queue:g1 60",
    );
  });
});

describe("eval reply framing", () => {
  it("consumes a bulk reply whole instead of leaving its tail behind", async () => {
    const { connection, sent } = fakeConnection((message) =>
      message.includes("EVAL") ? "$8\r\nabcdefgh\r\n" : ":42\r\n",
    );

    // The helper only resolves integers, but the reply must be framed off
    // the connection either way.
    await expect(redisEval(connection, "return 'abcdefgh'")).rejects.toThrow(
      /Not an integer reply: bulk/,
    );
    // The next command on the same connection is unaffected.
    expect(await redisIncr(connection, "counter")).toBe(42);
    expect(sent).toHaveLength(2);
  });

  it("consumes a flat array reply whole", async () => {
    const { connection } = fakeConnection((message) =>
      message.includes("EVAL") ? "*2\r\n:7\r\n:8\r\n" : ":42\r\n",
    );

    await expect(redisEval(connection, "return {7,8}")).rejects.toThrow(
      /Not an integer reply: array/,
    );
    expect(await redisIncr(connection, "counter")).toBe(42);
  });

  it("consumes a null bulk reply", async () => {
    const { connection } = fakeConnection((message) =>
      message.includes("EVAL") ? "$-1\r\n" : ":42\r\n",
    );

    await expect(redisEval(connection, "return nil")).rejects.toThrow(
      /Not an integer reply: bulk/,
    );
    expect(await redisIncr(connection, "counter")).toBe(42);
  });

  it("reports a script error as an error, not as a shape mismatch", async () => {
    const { connection } = fakeConnection(() => "-ERR bad script\r\n");
    await expect(redisEval(connection, "boom")).rejects.toThrow(/bad script/);
  });
});
