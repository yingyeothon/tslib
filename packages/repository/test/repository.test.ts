import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInMemoryRepository,
  createListDocument,
  createMapDocument,
  createRepositoryFromKV,
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
