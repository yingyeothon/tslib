import { createMapDocument } from "@yingyeothon/repository";
import { redisSend, type RedisConnection } from "@yingyeothon/naive-redis";
import { expect } from "vitest";
import type { RedisRepository } from "../src/index.js";
import { fixture } from "./fixture.js";

interface Session {
  id: string;
  expiresIn: number;
}

fixture("get-set", async (repo) => {
  const key = "test-key-1";
  const value: Session = {
    id: "tester",
    expiresIn: 600,
  };

  const maybeNull = await repo.get<Session>(key);
  expect(maybeNull).toBeUndefined();

  await expect(repo.set(key, value)).rejects.toThrow(
    /stores every key with a TTL; use setWithExpire/,
  );
  await repo.setWithExpire(key, value, 60_000);
  const maybeSession = await repo.get<Session>(key);
  expect(maybeSession).toEqual(value);

  await repo.delete(key);
  const deleted = await repo.get<Session>(key);
  expect(deleted).toBeUndefined();
});

function sleep(millis: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, millis));
}

fixture("set-with-expire", async (repo) => {
  const key = "test-key-2";
  const value: Session = {
    id: "tester",
    expiresIn: 600,
  };

  const maybeNull = await repo.get<Session>(key);
  expect(maybeNull).toBeUndefined();

  const ttl = 50;
  await repo.setWithExpire(key, value, ttl);
  const maybeSession = await repo.get<Session>(key);
  expect(maybeSession).toEqual(value);

  await sleep(ttl + 1);
  const maybeExpired = await repo.get<Session>(key);
  expect(maybeExpired).toBeUndefined();
});

function pttl(connection: RedisConnection, redisKey: string): Promise<number> {
  return redisSend({
    connection,
    commands: [`PTTL ${redisKey}`],
    match: (m) => m.capture("\r\n"),
    transform: (result) => Number.parseInt((result[0] ?? "").slice(1), 10),
  });
}

fixture("compare-and-set", async (repo, connection) => {
  const key = "cas-key";
  expect(await repo.getRevision(key)).toBeUndefined();

  // Absent key: only "must not exist" (undefined token) can create it.
  expect(
    await repo.compareAndSet(
      key,
      "anything",
      { n: 0 },
      { expiresInMillis: 60_000 },
    ),
  ).toEqual(false);
  expect(await repo.get(key)).toBeUndefined();
  expect(
    await repo.compareAndSet(
      key,
      undefined,
      { n: 1 },
      { expiresInMillis: 60_000 },
    ),
  ).toEqual(true);
  const ttl = await pttl(connection, `repo:${key}`);
  expect(ttl).toBeGreaterThan(0);
  expect(ttl).toBeLessThanOrEqual(60_000);

  const first = await repo.getRevision<{ n: number }>(key);
  expect(first?.value).toEqual({ n: 1 });

  // Existing key: "must not exist" and a stale token both fail; the current
  // token succeeds, and the TTL is re-applied.
  expect(
    await repo.compareAndSet(
      key,
      undefined,
      { n: 2 },
      { expiresInMillis: 60_000 },
    ),
  ).toEqual(false);
  expect(
    await repo.compareAndSet(
      key,
      "stale",
      { n: 2 },
      { expiresInMillis: 60_000 },
    ),
  ).toEqual(false);
  expect(await repo.get(key)).toEqual({ n: 1 });
  expect(
    await repo.compareAndSet(
      key,
      first?.token,
      { n: 2 },
      { expiresInMillis: 1_000 },
    ),
  ).toEqual(true);
  expect(await repo.get(key)).toEqual({ n: 2 });
  const second = await repo.getRevision<{ n: number }>(key);
  expect(second?.token).not.toEqual(first?.token);
  const shorter = await pttl(connection, `repo:${key}`);
  expect(shorter).toBeGreaterThan(0);
  expect(shorter).toBeLessThanOrEqual(1_000);

  // The token that won is spent.
  expect(
    await repo.compareAndSet(
      key,
      first?.token,
      { n: 3 },
      { expiresInMillis: 1_000 },
    ),
  ).toEqual(false);
  await expect(
    repo.compareAndSet(key, second?.token, { n: 3 }),
  ).rejects.toThrow("stores every key with a TTL");
});

fixture(
  "keeps both writers' changes when their edits interleave",
  async (repo) => {
    // `b` reads, then `a` reads and writes, then `b`'s conditional write lands
    // on a revision it never saw: `b` must retry, not clobber `a`.
    let aWrite: Promise<unknown> = Promise.resolve();
    let firstWrite = true;
    const raced: RedisRepository = {
      ...repo,
      compareAndSet: async (
        ...args: Parameters<RedisRepository["compareAndSet"]>
      ): Promise<boolean> => {
        if (firstWrite) {
          firstWrite = false;
          await aWrite;
        }
        return repo.compareAndSet(...args);
      },
    };
    const options = { key: "scores", expiresInMillis: 60_000 };
    const a = createMapDocument<number>({ repository: repo, ...options });
    const b = createMapDocument<number>({ repository: raced, ...options });
    await a.insertOrUpdate("seed", 5);

    const bWrite = b.edit((values) => ({ ...values, b: 2 }));
    aWrite = a.insertOrUpdate("a", 1);
    const result = await bWrite;

    expect(result.content).toEqual({ seed: 5, a: 1, b: 2 });
    expect(result.version).toBe(3);
    expect((await a.read()).content).toEqual({ seed: 5, a: 1, b: 2 });
  },
);
