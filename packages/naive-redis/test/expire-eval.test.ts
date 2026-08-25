import { expect } from "vitest";
import { redisEval, redisExpire, redisGet, redisSet } from "../src/index.js";
import { fixture } from "./fixture.js";

fixture("expire sets a ttl and reports a missing key", async (connection) => {
  const key = "naive-redis-expire-test";
  expect(await redisExpire(connection, key, 60)).toBe(false);

  await redisSet(connection, key, "value");
  expect(await redisExpire(connection, key, 1)).toBe(true);

  // The key is still there right after the TTL is applied.
  expect(await redisGet(connection, key)).toBe("value");

  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(await redisGet(connection, key)).toBeNull();
});

fixture("expire re-applies a ttl on an existing key", async (connection) => {
  const key = "naive-redis-expire-refresh-test";
  await redisSet(connection, key, "value", { expirationMillis: 500 });
  expect(await redisExpire(connection, key, 30)).toBe(true);

  await new Promise((resolve) => setTimeout(resolve, 700));
  expect(await redisGet(connection, key)).toBe("value");
});

fixture("eval runs a compare-and-delete script", async (connection) => {
  const key = "naive-redis-eval-test";
  const script =
    'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';

  await redisSet(connection, key, "mine");

  // A different token must not delete the key.
  expect(
    await redisEval(connection, script, { keys: [key], args: ["theirs"] }),
  ).toBe(0);
  expect(await redisGet(connection, key)).toBe("mine");

  expect(
    await redisEval(connection, script, { keys: [key], args: ["mine"] }),
  ).toBe(1);
  expect(await redisGet(connection, key)).toBeNull();
});

fixture(
  "eval carries a value that would break inline framing",
  async (connection) => {
    const key = "naive-redis-eval-framing-test";
    const witness = "naive-redis-eval-framing-witness";
    const token = 'a\r\nFLUSHALL "b"';
    await redisSet(connection, witness, "still here");
    // `redisSet` frames it correctly; `redisGet` cannot read a value with a
    // `\r\n` back, so the script is what reads it here.
    await redisSet(connection, key, token);

    expect(
      await redisEval(
        connection,
        'if redis.call("GET", KEYS[1]) == ARGV[1] then return 1 else return 0 end',
        { keys: [key], args: [token] },
      ),
    ).toBe(1);
    // The embedded `FLUSHALL` never ran as a command.
    expect(await redisGet(connection, witness)).toBe("still here");
  },
);

fixture("eval surfaces a script error", async (connection) => {
  await expect(redisEval(connection, "this is not lua")).rejects.toThrow();
});

fixture(
  "an unexpected eval reply does not desynchronize the connection",
  async (connection) => {
    await redisSet(connection, "eval-sync-witness", "intact");

    // Each of these answers with a shape the helper does not resolve. The
    // reply must still be consumed whole, or the next command resolves with
    // a fragment of this one and nothing reports an error.
    for (const script of [
      "return 'a string'",
      "return {1, 2, 3}",
      "return nil",
      "return redis.status_reply('OK')",
    ]) {
      await expect(redisEval(connection, script)).rejects.toThrow();
      expect(await redisGet(connection, "eval-sync-witness")).toBe("intact");
    }

    // And an integer script still works on the same connection afterwards.
    expect(await redisEval(connection, "return 11")).toBe(11);
  },
);

fixture(
  "expire refuses a TTL that would delete the key",
  async (connection) => {
    await redisSet(connection, "expire-guard", "value");

    // `EXPIRE key 0` means "delete now"; a caller that computed a zero by
    // accident must not be told the TTL was applied.
    await expect(redisExpire(connection, "expire-guard", 0)).rejects.toThrow();
    await expect(redisExpire(connection, "expire-guard", -5)).rejects.toThrow();
    await expect(
      redisExpire(connection, "expire-guard", Number.NaN),
    ).rejects.toThrow();

    expect(await redisGet(connection, "expire-guard")).toBe("value");
  },
);

fixture("a value with a single quote round-trips", async (connection) => {
  // The inline form would break framing here and Redis would close the
  // connection with "unbalanced quotes".
  await redisSet(connection, "quote'key", "it's fine");
  expect(await redisGet(connection, "quote'key")).toBe("it's fine");

  expect(await redisExpire(connection, "quote'key", 60)).toBe(true);
  expect(await redisGet(connection, "quote'key")).toBe("it's fine");
});
