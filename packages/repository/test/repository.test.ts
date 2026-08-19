import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryRepository,
  ListDocument,
  MapDocument,
  SimpleRepository,
  type ExpirableRepository,
  type Repository,
} from "../src/index.js";

describe("InMemoryRepository", () => {
  it("returns the stored value after set", async () => {
    const mem: Repository = new InMemoryRepository();
    const expected = { hi: "there" };
    await mem.set("hello", expected);
    expect(await mem.get("hello")).toEqual(expected);
  });

  it("returns undefined for an absent key", async () => {
    const mem: Repository = new InMemoryRepository();
    expect(await mem.get("hello")).toBeUndefined();
  });

  it("returns undefined after delete", async () => {
    const mem: Repository = new InMemoryRepository();
    const expected = { hi: "there" };
    await mem.set("hello", expected);
    expect(await mem.get("hello")).toEqual(expected);

    await mem.delete("hello");
    expect(await mem.get("hello")).toBeUndefined();
  });

  it("deleting an absent key is a no-op", async () => {
    const mem: Repository = new InMemoryRepository();
    await expect(mem.delete("nothing")).resolves.toBeUndefined();
  });

  it("set overwrites a previous value", async () => {
    const mem: Repository = new InMemoryRepository();
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
      const mem: ExpirableRepository = new InMemoryRepository();
      const expected = { hi: "there" };
      await mem.setWithExpire("hello", expected, 10);
      expect(await mem.get("hello")).toEqual(expected);

      vi.advanceTimersByTime(9);
      expect(await mem.get("hello")).toEqual(expected);

      vi.advanceTimersByTime(2);
      expect(await mem.get("hello")).toBeUndefined();
    });

    it("treats a non-positive TTL as never expiring", async () => {
      const mem: ExpirableRepository = new InMemoryRepository();
      await mem.setWithExpire("zero", "value", 0);
      await mem.setWithExpire("negative", "value", -5);

      vi.advanceTimersByTime(1_000_000);
      expect(await mem.get("zero")).toBe("value");
      expect(await mem.get("negative")).toBe("value");
    });

    it("set clears a previous expiration", async () => {
      const mem: ExpirableRepository = new InMemoryRepository();
      await mem.setWithExpire("key", "expiring", 10);
      await mem.set("key", "persistent");

      vi.advanceTimersByTime(1_000);
      expect(await mem.get("key")).toBe("persistent");
    });

    it("setWithExpire refreshes the TTL of an existing key", async () => {
      const mem: ExpirableRepository = new InMemoryRepository();
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

describe("SimpleRepository document factories", () => {
  it("creates a ListDocument bound to the repository", async () => {
    const mem = new InMemoryRepository();
    const list = mem.getListDocument<string>("list-key");
    expect(list).toBeInstanceOf(ListDocument);

    await list.insert("a");
    expect(await mem.get("list-key")).toEqual({
      version: 1,
      content: ["a"],
    });
  });

  it("creates a MapDocument bound to the repository", async () => {
    const mem = new InMemoryRepository();
    const map = mem.getMapDocument<string>("map-key");
    expect(map).toBeInstanceOf(MapDocument);

    await map.insertOrUpdate("k", "v");
    expect(await mem.get("map-key")).toEqual({
      version: 1,
      content: { k: "v" },
    });
  });

  it("works with a custom SimpleRepository subclass", async () => {
    class RecordRepository extends SimpleRepository {
      public readonly store: Record<string, unknown> = {};
      public get<T>(key: string): Promise<T | undefined> {
        return Promise.resolve(this.store[key] as T | undefined);
      }
      public set<T>(key: string, value: T): Promise<void> {
        this.store[key] = value;
        return Promise.resolve();
      }
      public delete(key: string): Promise<void> {
        delete this.store[key];
        return Promise.resolve();
      }
    }

    const repo = new RecordRepository();
    const list = repo.getListDocument<number>("numbers");
    await list.insert(1);
    await list.insert(2);
    expect(await list.view((values) => values.length)).toBe(2);
  });
});

describe("ListDocument", () => {
  function newList<V = string>(key = "list") {
    const mem = new InMemoryRepository();
    return { mem, list: new ListDocument<V>(mem, key) };
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

describe("MapDocument", () => {
  function newMap<V = string>(key = "map") {
    const mem = new InMemoryRepository();
    return { mem, map: new MapDocument<V>(mem, key) };
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
