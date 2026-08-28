import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInMemoryRepository,
  createListDocument,
  createMapDocument,
  createRepositoryFromKV,
  isCasRepository,
  type ExpirableRepository,
  type Repository,
} from "../src/index.js";

describe("createInMemoryRepository", () => {
  it("returns the stored value after set", async () => {
    const mem: Repository = createInMemoryRepository();
    const expected = { hi: "there" };
    await mem.set("hello", expected);
    expect(await mem.get("hello")).toEqual(expected);
  });

  it("returns undefined for an absent key", async () => {
    const mem: Repository = createInMemoryRepository();
    expect(await mem.get("hello")).toBeUndefined();
  });

  it("returns undefined after delete", async () => {
    const mem: Repository = createInMemoryRepository();
    const expected = { hi: "there" };
    await mem.set("hello", expected);
    expect(await mem.get("hello")).toEqual(expected);

    await mem.delete("hello");
    expect(await mem.get("hello")).toBeUndefined();
  });

  it("deleting an absent key is a no-op", async () => {
    const mem: Repository = createInMemoryRepository();
    await expect(mem.delete("nothing")).resolves.toBeUndefined();
  });

  it("set overwrites a previous value", async () => {
    const mem: Repository = createInMemoryRepository();
    await mem.set("key", "first");
    await mem.set("key", "second");
    expect(await mem.get("key")).toBe("second");
  });

  describe("expiration", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns the value before the TTL elapses and undefined after", async () => {
      const mem: ExpirableRepository = createInMemoryRepository();
      const expected = { hi: "there" };
      await mem.setWithExpire("hello", expected, 10);
      expect(await mem.get("hello")).toEqual(expected);

      vi.advanceTimersByTime(9);
      expect(await mem.get("hello")).toEqual(expected);

      vi.advanceTimersByTime(2);
      expect(await mem.get("hello")).toBeUndefined();
    });

    it("treats a non-positive TTL as never expiring", async () => {
      const mem: ExpirableRepository = createInMemoryRepository();
      await mem.setWithExpire("zero", "value", 0);
      await mem.setWithExpire("negative", "value", -5);

      vi.advanceTimersByTime(1_000_000);
      expect(await mem.get("zero")).toBe("value");
      expect(await mem.get("negative")).toBe("value");
    });

    it("set clears a previous expiration", async () => {
      const mem: ExpirableRepository = createInMemoryRepository();
      await mem.setWithExpire("key", "expiring", 10);
      await mem.set("key", "persistent");

      vi.advanceTimersByTime(1_000);
      expect(await mem.get("key")).toBe("persistent");
    });

    it("setWithExpire refreshes the TTL of an existing key", async () => {
      const mem: ExpirableRepository = createInMemoryRepository();
      await mem.setWithExpire("key", "v1", 10);
      vi.advanceTimersByTime(8);
      await mem.setWithExpire("key", "v2", 10);
      vi.advanceTimersByTime(8);
      expect(await mem.get("key")).toBe("v2");

      vi.advanceTimersByTime(3);
      expect(await mem.get("key")).toBeUndefined();
    });
  });
});

describe("createRepositoryFromKV", () => {
  function newStringStore() {
    const store = new Map<string, string>();
    return {
      store,
      primitives: {
        get: (key: string) => Promise.resolve(store.get(key)),
        set: (key: string, serialized: string) => {
          store.set(key, serialized);
          return Promise.resolve();
        },
        delete: (key: string) => {
          store.delete(key);
          return Promise.resolve();
        },
      },
    };
  }

  it("round-trips structured values through JSON serialization", async () => {
    const { store, primitives } = newStringStore();
    const repo = createRepositoryFromKV(primitives);
    const expected = { hi: "there", n: 42, list: [1, 2] };
    await repo.set("key", expected);
    expect(store.get("key")).toBe(JSON.stringify(expected));
    expect(await repo.get("key")).toEqual(expected);
  });

  it("returns undefined when the primitive store has no value", async () => {
    const repo = createRepositoryFromKV(newStringStore().primitives);
    expect(await repo.get("absent")).toBeUndefined();
  });

  it("delete removes the underlying entry", async () => {
    const { store, primitives } = newStringStore();
    const repo = createRepositoryFromKV(primitives);
    await repo.set("key", "value");
    await repo.delete("key");
    expect(store.has("key")).toBe(false);
    expect(await repo.get("key")).toBeUndefined();
  });

  it("does not expose setWithExpire when the primitive is absent", () => {
    const repo = createRepositoryFromKV(newStringStore().primitives);
    expect("setWithExpire" in repo).toBe(false);
  });

  it("exposes setWithExpire when the primitive is provided", async () => {
    const { store, primitives } = newStringStore();
    const calls: Array<[string, string, number]> = [];
    const repo = createRepositoryFromKV({
      ...primitives,
      setWithExpire: (key, serialized, expiresInMillis) => {
        calls.push([key, serialized, expiresInMillis]);
        store.set(key, serialized);
        return Promise.resolve();
      },
    });
    await repo.setWithExpire("key", { a: 1 }, 1000);
    expect(calls).toEqual([["key", JSON.stringify({ a: 1 }), 1000]]);
    expect(await repo.get("key")).toEqual({ a: 1 });
  });

  it("documents work on top of a KV-built repository", async () => {
    const repo = createRepositoryFromKV(newStringStore().primitives);
    const list = createListDocument<number>({ repository: repo, key: "n" });
    await list.insert(1);
    await list.insert(2);
    expect(await list.view((values) => values.length)).toBe(2);
  });
});

describe("createListDocument", () => {
  function newList<V = string>(key = "list") {
    const mem = createInMemoryRepository();
    return { mem, list: createListDocument<V>({ repository: mem, key }) };
  }

  it("reads an empty document at version 0 when nothing is stored", async () => {
    const { list } = newList();
    expect(await list.read()).toEqual({ version: 0, content: [] });
  });

  it("insert appends values and bumps the version", async () => {
    const { list } = newList();
    expect(await list.insert("a")).toEqual({ version: 1, content: ["a"] });
    expect(await list.insert("b")).toEqual({
      version: 2,
      content: ["a", "b"],
    });
  });

  it("writes documents under the given key", async () => {
    const { mem, list } = newList("list-key");
    await list.insert("a");
    expect(await mem.get("list-key")).toEqual({
      version: 1,
      content: ["a"],
    });
  });

  it("deleteIf removes matching values", async () => {
    const { list } = newList<number>();
    await list.insert(1);
    await list.insert(2);
    await list.insert(3);
    expect(await list.deleteIf((value) => value % 2 === 1)).toEqual({
      version: 4,
      content: [2],
    });
  });

  it("truncate deletes the underlying document", async () => {
    const { mem, list } = newList();
    await list.insert("a");
    await list.truncate();
    expect(await mem.get("list")).toBeUndefined();
    expect(await list.read()).toEqual({ version: 0, content: [] });
  });

  it("edit applies an arbitrary modifier", async () => {
    const { list } = newList<string>();
    await list.insert("b");
    await list.insert("a");
    expect(await list.edit((values) => [...values].sort())).toEqual({
      version: 3,
      content: ["a", "b"],
    });
  });

  it("view projects the current content", async () => {
    const { list } = newList<number>();
    await list.insert(1);
    await list.insert(2);
    expect(await list.view((values) => values.reduce((a, b) => a + b, 0))).toBe(
      3,
    );
  });

  it("normalizes a partially malformed stored document", async () => {
    const { mem, list } = newList();
    await mem.set("list", { version: undefined, content: undefined });
    expect(await list.read()).toEqual({ version: 0, content: [] });
  });
});

describe("createMapDocument", () => {
  function newMap<V = string>(key = "map") {
    const mem = createInMemoryRepository();
    return { mem, map: createMapDocument<V>({ repository: mem, key }) };
  }

  it("reads an empty document at version 0 when nothing is stored", async () => {
    const { map } = newMap();
    expect(await map.read()).toEqual({ version: 0, content: {} });
  });

  it("insertOrUpdate inserts and updates entries", async () => {
    const { map } = newMap();
    expect(await map.insertOrUpdate("k", "v1")).toEqual({
      version: 1,
      content: { k: "v1" },
    });
    expect(await map.insertOrUpdate("k", "v2")).toEqual({
      version: 2,
      content: { k: "v2" },
    });
  });

  it("writes documents under the given key", async () => {
    const { mem, map } = newMap("map-key");
    await map.insertOrUpdate("k", "v");
    expect(await mem.get("map-key")).toEqual({
      version: 1,
      content: { k: "v" },
    });
  });

  it("insertOrUpdate with undefined removes the entry", async () => {
    const { map } = newMap();
    await map.insertOrUpdate("a", "1");
    await map.insertOrUpdate("b", "2");
    expect(await map.insertOrUpdate("a", undefined)).toEqual({
      version: 3,
      content: { b: "2" },
    });
  });

  it("delete removes the entry", async () => {
    const { map } = newMap();
    await map.insertOrUpdate("a", "1");
    expect(await map.delete("a")).toEqual({ version: 2, content: {} });
  });

  it("truncate deletes the underlying document", async () => {
    const { mem, map } = newMap();
    await map.insertOrUpdate("a", "1");
    await map.truncate();
    expect(await mem.get("map")).toBeUndefined();
    expect(await map.read()).toEqual({ version: 0, content: {} });
  });

  it("edit applies an arbitrary modifier", async () => {
    const { map } = newMap<number>();
    await map.insertOrUpdate("a", 1);
    expect(
      await map.edit((values) =>
        Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v * 10])),
      ),
    ).toEqual({ version: 2, content: { a: 10 } });
  });

  it("view projects the current content", async () => {
    const { map } = newMap();
    await map.insertOrUpdate("a", "1");
    await map.insertOrUpdate("b", "2");
    expect(await map.view((values) => Object.keys(values).sort())).toEqual([
      "a",
      "b",
    ]);
  });

  it("normalizes a partially malformed stored document", async () => {
    const { mem, map } = newMap();
    await mem.set("map", { version: undefined, content: undefined });
    expect(await map.read()).toEqual({ version: 0, content: {} });
  });
});

describe("compare-and-set", () => {
  it("writes only when the token matches what was read", async () => {
    const mem = createInMemoryRepository();
    expect(await mem.getRevision("k")).toBeUndefined();

    // Absent key: only an `undefined` token may create it.
    expect(await mem.compareAndSet("k", "stale", 1)).toBe(false);
    expect(await mem.get("k")).toBeUndefined();
    expect(await mem.compareAndSet("k", undefined, 1)).toBe(true);

    const first = await mem.getRevision<number>("k");
    expect(first).toMatchObject({ value: 1 });

    // Existing key: the token from the read wins, `undefined` loses.
    expect(await mem.compareAndSet("k", undefined, 2)).toBe(false);
    expect(await mem.compareAndSet("k", first?.token, 2)).toBe(true);
    expect(await mem.get("k")).toBe(2);
    // The old token is now stale.
    expect(await mem.compareAndSet("k", first?.token, 3)).toBe(false);
    expect(await mem.get("k")).toBe(2);
  });

  it("treats an expired entry as absent", async () => {
    vi.useFakeTimers();
    try {
      const mem = createInMemoryRepository();
      await mem.setWithExpire("k", "v", 10);
      const revision = await mem.getRevision("k");
      vi.advanceTimersByTime(11);
      expect(await mem.getRevision("k")).toBeUndefined();
      expect(await mem.compareAndSet("k", revision?.token, "w")).toBe(false);
      expect(
        await mem.compareAndSet("k", undefined, "w", { expiresInMillis: 10 }),
      ).toBe(true);
      expect(await mem.get("k")).toBe("w");
      vi.advanceTimersByTime(11);
      expect(await mem.get("k")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("createRepositoryFromKV exposes CAS only when both primitives exist", async () => {
    const store = new Map<string, string>();
    const base = {
      get: (key: string) => Promise.resolve(store.get(key)),
      set: (key: string, serialized: string) => {
        store.set(key, serialized);
        return Promise.resolve();
      },
      delete: (key: string) => {
        store.delete(key);
        return Promise.resolve();
      },
    };
    expect(isCasRepository(createRepositoryFromKV(base))).toBe(false);
    expect(
      isCasRepository(
        createRepositoryFromKV({
          ...base,
          getRevision: () => Promise.resolve(undefined),
        }),
      ),
    ).toBe(false);

    const cas = createRepositoryFromKV({
      ...base,
      getRevision: (key: string) => {
        const serialized = store.get(key);
        return Promise.resolve(
          serialized === undefined
            ? undefined
            : { serialized, token: serialized },
        );
      },
      compareAndSet: (key, expectedToken, serialized) => {
        if (store.get(key) !== expectedToken) {
          return Promise.resolve(false);
        }
        store.set(key, serialized);
        return Promise.resolve(true);
      },
    });
    expect(isCasRepository(cas)).toBe(true);
    expect(await cas.compareAndSet("k", undefined, { n: 1 })).toBe(true);
    const revision = await cas.getRevision<{ n: number }>("k");
    expect(revision).toEqual({ value: { n: 1 }, token: '{"n":1}' });
    expect(await cas.compareAndSet("k", revision?.token, { n: 2 })).toBe(true);
    expect(await cas.get("k")).toEqual({ n: 2 });
  });
});

describe("documents on a CAS repository", () => {
  it("keeps both writers' changes when their edits interleave", async () => {
    const mem = createInMemoryRepository();
    // `b` reads, then `a` reads and writes, then `b`'s conditional write
    // lands on a revision it never saw: `b` must retry, not clobber `a`.
    let aWrite: Promise<unknown> = Promise.resolve();
    let firstWrite = true;
    const raced = {
      ...mem,
      compareAndSet: async (
        ...args: Parameters<typeof mem.compareAndSet>
      ): Promise<boolean> => {
        if (firstWrite) {
          firstWrite = false;
          await aWrite;
        }
        return mem.compareAndSet(...args);
      },
    };
    const a = createMapDocument<number>({ repository: mem, key: "scores" });
    const b = createMapDocument<number>({ repository: raced, key: "scores" });
    await a.insertOrUpdate("seed", 5);

    const bWrite = b.edit((values) => ({ ...values, b: 2 }));
    aWrite = a.insertOrUpdate("a", 1);
    const result = await bWrite;

    // Without CAS b would have written its stale view, dropping "a".
    expect(result.content).toEqual({ seed: 5, a: 1, b: 2 });
    expect(result.version).toBe(3);
    expect((await a.read()).content).toEqual({ seed: 5, a: 1, b: 2 });
  });

  it("gives up after maxRetries lost races", async () => {
    const mem = createInMemoryRepository();
    let attempts = 0;
    const alwaysLosing = {
      ...mem,
      compareAndSet: () => {
        attempts += 1;
        return Promise.resolve(false);
      },
    };
    const list = createListDocument<string>({
      repository: alwaysLosing,
      key: "todo",
      maxRetries: 2,
    });
    await expect(list.insert("x")).rejects.toThrow(
      /Concurrent modification of "todo" \(gave up after 3 attempts\)/,
    );
    expect(attempts).toBe(3);
  });

  it("passes expiresInMillis through to the conditional write", async () => {
    vi.useFakeTimers();
    try {
      const mem = createInMemoryRepository();
      const list = createListDocument<string>({
        repository: mem,
        key: "todo",
        expiresInMillis: 10,
      });
      await list.insert("x");
      expect((await list.read()).content).toEqual(["x"]);
      vi.advanceTimersByTime(11);
      expect((await list.read()).content).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("stored values are not shared references for CAS", () => {
  it("survives a modifier that mutates the read value in place", async () => {
    const mem = createInMemoryRepository();
    const list = createListDocument<string>({ repository: mem, key: "l" });
    await list.insert("a");
    // The modifier pushes into the array it was handed instead of copying.
    // If the token were recomputed from the (now mutated) stored object,
    // a single writer would lose every race against itself.
    const result = await list.edit((values) => {
      values.push("b");
      return values;
    });
    expect(result.content).toEqual(["a", "b"]);
    expect(result.version).toBe(2);
  });

  it("refuses to store undefined through set, setWithExpire and compareAndSet", async () => {
    const store = new Map<string, string>();
    const repo = createRepositoryFromKV({
      get: (key) => Promise.resolve(store.get(key)),
      set: (key, serialized) => {
        store.set(key, serialized);
        return Promise.resolve();
      },
      delete: (key) => {
        store.delete(key);
        return Promise.resolve();
      },
      setWithExpire: (key, serialized) => {
        store.set(key, serialized);
        return Promise.resolve();
      },
      getRevision: (key) => {
        const serialized = store.get(key);
        return Promise.resolve(
          serialized === undefined ? undefined : { serialized, token: "t" },
        );
      },
      compareAndSet: (key, _token, serialized) => {
        store.set(key, serialized);
        return Promise.resolve(true);
      },
    });
    const message = /Cannot store undefined/;
    await expect(repo.set("k", undefined)).rejects.toThrow(message);
    await expect(repo.setWithExpire("k", undefined, 10)).rejects.toThrow(
      message,
    );
    await expect(repo.compareAndSet("k", undefined, undefined)).rejects.toThrow(
      message,
    );
    expect(store.size).toBe(0);
  });
});

describe("documents on a plain repository", () => {
  function plainRepository(): Repository & { writes: string[] } {
    const store = new Map<string, unknown>();
    const writes: string[] = [];
    return {
      writes,
      get: <T>(key: string) => Promise.resolve(store.get(key) as T | undefined),
      set: (key, value) => {
        writes.push(`set:${key}`);
        store.set(key, value);
        return Promise.resolve();
      },
      delete: (key) => {
        store.delete(key);
        return Promise.resolve();
      },
    };
  }

  it("falls back to set when the repository has no CAS", async () => {
    const repo = plainRepository();
    const map = createMapDocument<number>({ repository: repo, key: "m" });
    await map.insertOrUpdate("a", 1);
    expect(repo.writes).toEqual(["set:m"]);
    expect((await map.read()).content).toEqual({ a: 1 });
  });

  it("uses setWithExpire when a TTL is given and the repository is expirable", async () => {
    const repo = plainRepository();
    const writes: string[] = [];
    const expirable: ExpirableRepository = {
      ...repo,
      setWithExpire: (key, value, ttl) => {
        writes.push(`expire:${key}:${ttl}`);
        return repo.set(key, value);
      },
    };
    const map = createMapDocument<number>({
      repository: expirable,
      key: "m",
      expiresInMillis: 500,
    });
    await map.insertOrUpdate("a", 1);
    expect(writes).toEqual(["expire:m:500"]);
    expect(repo.writes).toEqual(["set:m"]);
  });
});
