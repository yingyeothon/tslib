import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  type PutCommandInput,
} from "@aws-sdk/lib-dynamodb";
import type { Codec } from "@yingyeothon/codec";
import { createMapDocument } from "@yingyeothon/repository";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDynamoRepository } from "../src/index.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

type Item = Record<string, unknown>;

function conditionFailed(): Error {
  return Object.assign(new Error("The conditional request failed"), {
    name: "ConditionalCheckFailedException",
  });
}

// Evaluates exactly the two condition expressions the repository emits; any
// other expression is a test failure, not "unknown → true".
function conditionHolds(
  input: PutCommandInput,
  existing: Item | undefined,
): boolean {
  const names = input.ExpressionAttributeNames ?? {};
  const values = input.ExpressionAttributeValues ?? {};
  const now = values[":now"] as number;
  const name = (placeholder: string): string => names[placeholder] ?? "";
  const ttl = existing?.[name("#ttl")] as number | undefined;
  switch (input.ConditionExpression) {
    case "attribute_not_exists(#pk) OR #ttl < :now":
      return (
        existing?.[name("#pk")] === undefined ||
        (ttl !== undefined && ttl < now)
      );
    case "#rev = :rev AND (attribute_not_exists(#ttl) OR #ttl >= :now)":
      return (
        existing?.[name("#rev")] === values[":rev"] &&
        (ttl === undefined || ttl >= now)
      );
    default:
      throw new Error(`unexpected condition ${input.ConditionExpression}`);
  }
}

function useInMemoryTable(keyAttribute = "pk"): Map<string, Item> {
  const table = new Map<string, Item>();
  ddbMock.on(GetCommand).callsFake((input: { Key: Item }) => ({
    Item: table.get(input.Key[keyAttribute] as string),
  }));
  ddbMock.on(PutCommand).callsFake((input: PutCommandInput) => {
    const item = input.Item as Item;
    const key = item[keyAttribute] as string;
    if (
      input.ConditionExpression !== undefined &&
      !conditionHolds(input, table.get(key))
    ) {
      throw conditionFailed();
    }
    table.set(key, item);
    return {};
  });
  ddbMock.on(DeleteCommand).callsFake((input: { Key: Item }) => {
    table.delete(input.Key[keyAttribute] as string);
    return {};
  });
  return table;
}

beforeEach(() => {
  ddbMock.reset();
});

afterEach(() => {
  ddbMock.restore();
  vi.useRealTimers();
});

const nowMillis = 1_700_000_000_000;

describe("createDynamoRepository", () => {
  it("supports the get/set/delete round-trip with a key prefix", async () => {
    const table = useInMemoryTable();
    const repo = createDynamoRepository({
      tableName: "test-table",
      prefix: "__test__/",
    });

    expect(await repo.get("hello")).toBeUndefined();
    await repo.set("hello", { value: 42 });
    expect(table.get("__test__/hello")).toMatchObject({
      pk: "__test__/hello",
      value: JSON.stringify({ value: 42 }),
      rev: expect.any(String) as string,
    });
    expect(table.get("__test__/hello")).not.toHaveProperty("ttl");
    expect(await repo.get("hello")).toEqual({ value: 42 });

    await repo.delete("hello");
    expect(table.has("__test__/hello")).toBe(false);
    expect(await repo.get("hello")).toBeUndefined();
    expect(
      ddbMock.commandCalls(DeleteCommand, {
        TableName: "test-table",
        Key: { pk: "__test__/hello" },
      }),
    ).toHaveLength(1);
  });

  it("uses the bare key and custom attribute names", async () => {
    const table = useInMemoryTable("id");
    const repo = createDynamoRepository({
      tableName: "test-table",
      keyAttribute: "id",
      ttlAttribute: "expiresAt",
    });

    await repo.setWithExpire("plain", 1, 1000);
    expect([...table.keys()]).toEqual(["plain"]);
    expect(table.get("plain")).toHaveProperty("id", "plain");
    expect(table.get("plain")).toHaveProperty("expiresAt");
    expect(await repo.get<number>("plain")).toEqual(1);
  });

  it("treats set(key, undefined) as a delete", async () => {
    const table = useInMemoryTable();
    const repo = createDynamoRepository({ tableName: "test-table" });

    await repo.set("gone", "value");
    await repo.set("gone", undefined);
    expect(table.has("gone")).toBe(false);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
  });

  it("accepts an injected document client", async () => {
    useInMemoryTable();
    const client = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: "ap-northeast-2" }),
    );
    const repo = createDynamoRepository({ tableName: "test-table", client });

    await repo.set("injected", true);
    expect(await repo.get<boolean>("injected")).toBe(true);
  });

  it("round-trips values through a custom codec", async () => {
    const table = useInMemoryTable();
    const base64Codec: Codec<string> = {
      encode: (item) => Buffer.from(JSON.stringify(item)).toString("base64"),
      decode: <T>(value: string) =>
        JSON.parse(Buffer.from(value, "base64").toString("utf-8")) as T,
    };
    const repo = createDynamoRepository({
      tableName: "test-table",
      codec: base64Codec,
    });

    await repo.set("encoded", { hello: "world" });
    expect(table.get("encoded")?.value).toEqual(
      Buffer.from(JSON.stringify({ hello: "world" })).toString("base64"),
    );
    expect(await repo.get("encoded")).toEqual({ hello: "world" });
    expect((await repo.getRevision("encoded"))?.value).toEqual({
      hello: "world",
    });
  });

  it("derives a repository with another prefix via withPrefix", async () => {
    const table = useInMemoryTable();
    const root = createDynamoRepository({
      tableName: "test-table",
      prefix: "a/",
    });
    const nested = root.withPrefix("b/");

    await root.set("key", 1);
    await nested.set("key", 2);
    expect(table.get("a/key")?.value).toEqual("1");
    expect(table.get("b/key")?.value).toEqual("2");
    expect(await nested.get<number>("key")).toEqual(2);
  });

  it("returns undefined for an item without a value attribute", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { pk: "odd" } });
    const repo = createDynamoRepository({ tableName: "test-table" });

    expect(await repo.get("odd")).toBeUndefined();
    expect(await repo.getRevision("odd")).toBeUndefined();
  });
});

describe("createDynamoRepository expiry", () => {
  it("writes the TTL in epoch seconds, rounded up", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMillis + 1);
    const table = useInMemoryTable();
    const repo = createDynamoRepository({ tableName: "test-table" });

    await repo.setWithExpire("session", "token", 1500);
    expect(table.get("session")?.ttl).toEqual(
      Math.ceil((nowMillis + 1 + 1500) / 1000),
    );
    expect(await repo.get("session")).toEqual("token");
  });

  it("rejects a non-positive TTL", async () => {
    useInMemoryTable();
    const repo = createDynamoRepository({ tableName: "test-table" });

    await expect(repo.setWithExpire("k", "v", 0)).rejects.toThrow(
      /positive expiresInMillis/,
    );
    await expect(repo.setWithExpire("k", "v", -1)).rejects.toThrow(
      /positive expiresInMillis/,
    );
    await expect(
      repo.compareAndSet("k", undefined, "v", { expiresInMillis: 0 }),
    ).rejects.toThrow(/positive expiresInMillis/);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("reads an expired-but-not-yet-deleted item as absent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMillis);
    const table = useInMemoryTable();
    const repo = createDynamoRepository({ tableName: "test-table" });

    await repo.setWithExpire("short", "value", 2000);
    expect(await repo.get("short")).toEqual("value");

    vi.setSystemTime(nowMillis + 3000);
    expect(table.has("short")).toBe(true);
    expect(await repo.get("short")).toBeUndefined();
    expect(await repo.getRevision("short")).toBeUndefined();
  });
});

describe("createDynamoRepository compareAndSet", () => {
  it("creates only when absent, then only with the current token", async () => {
    const table = useInMemoryTable();
    const repo = createDynamoRepository({ tableName: "test-table" });

    expect(await repo.compareAndSet("doc", undefined, 1)).toBe(true);
    expect(await repo.compareAndSet("doc", undefined, 2)).toBe(false);
    expect(await repo.get("doc")).toEqual(1);

    const first = await repo.getRevision<number>("doc");
    expect(first).toEqual({ value: 1, token: table.get("doc")?.rev });
    expect(await repo.compareAndSet("doc", first?.token, 2)).toBe(true);
    // The token is now stale.
    expect(await repo.compareAndSet("doc", first?.token, 3)).toBe(false);
    expect(await repo.get("doc")).toEqual(2);

    const second = await repo.getRevision<number>("doc");
    expect(second?.token).not.toEqual(first?.token);
    expect(await repo.compareAndSet("doc", second?.token, 3)).toBe(true);
    expect(await repo.get("doc")).toEqual(3);
  });

  it("sends the condition through attribute names and values", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMillis);
    useInMemoryTable();
    const repo = createDynamoRepository({
      tableName: "test-table",
      keyAttribute: "id",
      ttlAttribute: "expiresAt",
    });
    const now = Math.floor(nowMillis / 1000);

    await repo.compareAndSet("doc", undefined, "v", { expiresInMillis: 5000 });
    const rev = (await repo.getRevision("doc"))?.token;
    await repo.compareAndSet("doc", rev, "w");

    const [create, update] = ddbMock
      .commandCalls(PutCommand)
      .map((call) => call.args[0].input);
    expect(create).toEqual({
      TableName: "test-table",
      Item: {
        id: "doc",
        value: JSON.stringify("v"),
        rev: expect.any(String) as string,
        expiresAt: now + 5,
      },
      ConditionExpression: "attribute_not_exists(#pk) OR #ttl < :now",
      ExpressionAttributeNames: { "#pk": "id", "#ttl": "expiresAt" },
      ExpressionAttributeValues: { ":now": now },
    });
    expect(update).toEqual({
      TableName: "test-table",
      Item: {
        id: "doc",
        value: JSON.stringify("w"),
        rev: expect.any(String) as string,
      },
      ConditionExpression:
        "#rev = :rev AND (attribute_not_exists(#ttl) OR #ttl >= :now)",
      ExpressionAttributeNames: { "#rev": "rev", "#ttl": "expiresAt" },
      ExpressionAttributeValues: { ":rev": rev, ":now": now },
    });
  });

  it("recreates an expired ghost as absent and rejects its stale token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMillis);
    const table = useInMemoryTable();
    const repo = createDynamoRepository({ tableName: "test-table" });

    await repo.compareAndSet("ghost", undefined, "old", {
      expiresInMillis: 1000,
    });
    const live = await repo.getRevision("ghost");
    expect(live?.value).toEqual("old");

    vi.setSystemTime(nowMillis + 5000);
    expect(table.has("ghost")).toBe(true);
    // A token read before expiry must not revive the ghost...
    expect(await repo.compareAndSet("ghost", live?.token, "revived")).toBe(
      false,
    );
    expect(table.get("ghost")?.value).toEqual(JSON.stringify("old"));
    // ...but "absent" is allowed to overwrite it.
    expect(await repo.compareAndSet("ghost", undefined, "new")).toBe(true);
    expect(await repo.get("ghost")).toEqual("new");
    expect(await repo.compareAndSet("ghost", undefined, "again")).toBe(false);
  });

  it("maps ConditionalCheckFailedException to false and rethrows others", async () => {
    ddbMock
      .on(PutCommand)
      .rejectsOnce(conditionFailed())
      .rejects(
        Object.assign(new Error("Throughput exceeded"), {
          name: "ProvisionedThroughputExceededException",
        }),
      );
    const repo = createDynamoRepository({ tableName: "test-table" });

    expect(await repo.compareAndSet("k", undefined, "v")).toBe(false);
    await expect(repo.compareAndSet("k", undefined, "v")).rejects.toThrow(
      "Throughput exceeded",
    );
    await expect(repo.set("k", "v")).rejects.toThrow("Throughput exceeded");
  });
});

describe("createDynamoRepository map document", () => {
  it("supports insertOrUpdate/delete/truncate with versioning", async () => {
    useInMemoryTable();
    const repo = createDynamoRepository({
      tableName: "test-table",
      prefix: "__test__/",
    });
    const mapDoc = createMapDocument<string>({
      repository: repo,
      key: "map-doc",
    });

    expect(await mapDoc.read()).toEqual({ version: 0, content: {} });
    await mapDoc.insertOrUpdate("hello", "world");
    await mapDoc.insertOrUpdate("hi", "there");
    expect(await mapDoc.read()).toEqual({
      version: 2,
      content: { hello: "world", hi: "there" },
    });
    await mapDoc.delete("hello");
    expect(await mapDoc.read()).toEqual({
      version: 3,
      content: { hi: "there" },
    });
    await mapDoc.truncate();
    expect(await mapDoc.read()).toEqual({ version: 0, content: {} });
  });

  it("keeps both writers' changes when their edits interleave", async () => {
    useInMemoryTable();
    const repo = createDynamoRepository({ tableName: "test-table" });
    // `b` reads, then `a` reads and writes, then `b`'s conditional write
    // lands on a revision it never saw: `b` must retry, not clobber `a`.
    let aWrite: Promise<unknown> = Promise.resolve();
    let firstWrite = true;
    const raced = {
      ...repo,
      compareAndSet: async (
        ...args: Parameters<typeof repo.compareAndSet>
      ): Promise<boolean> => {
        if (firstWrite) {
          firstWrite = false;
          await aWrite;
        }
        return repo.compareAndSet(...args);
      },
    };
    const a = createMapDocument<number>({ repository: repo, key: "scores" });
    const b = createMapDocument<number>({ repository: raced, key: "scores" });
    await a.insertOrUpdate("seed", 5);

    const bWrite = b.edit((values) => ({ ...values, b: 2 }));
    aWrite = a.insertOrUpdate("a", 1);
    const result = await bWrite;

    expect(result.content).toEqual({ seed: 5, a: 1, b: 2 });
    expect(result.version).toBe(3);
    expect((await a.read()).content).toEqual({ seed: 5, a: 1, b: 2 });
  });
});
