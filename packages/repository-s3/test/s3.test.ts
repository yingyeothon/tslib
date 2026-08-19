import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import type { Codec } from "@yingyeothon/codec";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { S3Repository } from "../src/index.js";

const s3Mock = mockClient(S3);

function noSuchKey(): Error {
  return Object.assign(new Error("The specified key does not exist."), {
    name: "NoSuchKey",
  });
}

function textBody(text: string): GetObjectCommandOutput["Body"] {
  return {
    transformToString: () => Promise.resolve(text),
  } as GetObjectCommandOutput["Body"];
}

function useInMemoryBucket(): Map<string, string> {
  const store = new Map<string, string>();
  s3Mock.on(GetObjectCommand).callsFake((input: { Key: string }) => {
    const value = store.get(input.Key);
    if (value === undefined) {
      throw noSuchKey();
    }
    return { Body: textBody(value) };
  });
  s3Mock
    .on(PutObjectCommand)
    .callsFake((input: { Key: string; Body: string }) => {
      store.set(input.Key, input.Body);
      return {};
    });
  s3Mock.on(DeleteObjectCommand).callsFake((input: { Key: string }) => {
    store.delete(input.Key);
    return {};
  });
  return store;
}

beforeEach(() => {
  s3Mock.reset();
});

afterEach(() => {
  s3Mock.restore();
});

interface Message {
  payload: {
    value1: number;
    value2: string;
  };
}

describe("S3Repository", () => {
  it("supports the get/set/delete round-trip with a key prefix", async () => {
    const store = useInMemoryBucket();
    const s3 = new S3Repository({
      bucketName: "test-bucket",
      prefix: "__test__/",
    });

    const key = "hello";
    const message: Message = {
      payload: { value1: 100, value2: "typescript" },
    };
    expect(await s3.get<Message>(key)).toBeUndefined();

    await s3.set(key, message);
    expect(store.get("__test__/hello")).toEqual(JSON.stringify(message));
    expect(await s3.get<Message>(key)).toEqual(message);

    await s3.delete(key);
    expect(store.has("__test__/hello")).toBe(false);
    expect(await s3.get<Message>(key)).toBeUndefined();
  });

  it("uses the bare key when no prefix is given", async () => {
    const store = useInMemoryBucket();
    const s3 = new S3Repository({ bucketName: "test-bucket" });

    await s3.set("plain", 42);
    expect([...store.keys()]).toEqual(["plain"]);
    expect(await s3.get<number>("plain")).toEqual(42);
  });

  it("sends Bucket and Key to every S3 call", async () => {
    useInMemoryBucket();
    const s3 = new S3Repository({
      bucketName: "test-bucket",
      prefix: "p/",
    });

    await s3.set("k", "v");
    await s3.get("k");
    await s3.delete("k");

    expect(
      s3Mock.commandCalls(PutObjectCommand, {
        Bucket: "test-bucket",
        Key: "p/k",
        Body: JSON.stringify("v"),
      }),
    ).toHaveLength(1);
    expect(
      s3Mock.commandCalls(GetObjectCommand, {
        Bucket: "test-bucket",
        Key: "p/k",
      }),
    ).toHaveLength(1);
    expect(
      s3Mock.commandCalls(DeleteObjectCommand, {
        Bucket: "test-bucket",
        Key: "p/k",
      }),
    ).toHaveLength(1);
  });

  it("returns undefined when getObject fails with NoSuchKey", async () => {
    s3Mock.on(GetObjectCommand).rejects(noSuchKey());
    const s3 = new S3Repository({ bucketName: "test-bucket" });

    expect(await s3.get("missing")).toBeUndefined();
  });

  it("returns undefined when only the legacy error message matches", async () => {
    s3Mock
      .on(GetObjectCommand)
      .rejects(new Error("The specified key does not exist."));
    const s3 = new S3Repository({ bucketName: "test-bucket" });

    expect(await s3.get("missing")).toBeUndefined();
  });

  it("rethrows getObject errors other than NoSuchKey", async () => {
    s3Mock
      .on(GetObjectCommand)
      .rejects(
        Object.assign(new Error("Access Denied"), { name: "AccessDenied" }),
      );
    const s3 = new S3Repository({ bucketName: "test-bucket" });

    await expect(s3.get("forbidden")).rejects.toThrow("Access Denied");
  });

  it("returns undefined when the object has no body", async () => {
    s3Mock.on(GetObjectCommand).resolves({});
    const s3 = new S3Repository({ bucketName: "test-bucket" });

    expect(await s3.get("empty")).toBeUndefined();
  });

  it("treats set(key, undefined) as a delete", async () => {
    const store = useInMemoryBucket();
    const s3 = new S3Repository({ bucketName: "test-bucket" });

    await s3.set("gone", "value");
    expect(store.has("gone")).toBe(true);

    await s3.set("gone", undefined);
    expect(store.has("gone")).toBe(false);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  });

  it("accepts an injected S3 client", async () => {
    const store = useInMemoryBucket();
    const s3 = new S3Repository({
      bucketName: "test-bucket",
      s3: new S3({ region: "ap-northeast-2" }),
    });

    await s3.set("injected", true);
    expect(await s3.get<boolean>("injected")).toBe(true);
    expect(store.get("injected")).toEqual("true");
  });

  it("round-trips values through a custom codec", async () => {
    const store = useInMemoryBucket();
    const base64Codec: Codec<string> = {
      encode: (item) => Buffer.from(JSON.stringify(item)).toString("base64"),
      decode: <T>(value: string) =>
        JSON.parse(Buffer.from(value, "base64").toString("utf-8")) as T,
    };
    const s3 = new S3Repository({
      bucketName: "test-bucket",
      codec: base64Codec,
    });

    await s3.set("encoded", { hello: "world" });
    expect(store.get("encoded")).toEqual(
      Buffer.from(JSON.stringify({ hello: "world" })).toString("base64"),
    );
    expect(await s3.get("encoded")).toEqual({ hello: "world" });
  });

  it("derives a repository with another prefix via withPrefix", async () => {
    const store = useInMemoryBucket();
    const root = new S3Repository({
      bucketName: "test-bucket",
      prefix: "a/",
    });
    const nested = root.withPrefix("b/");

    await root.set("key", 1);
    await nested.set("key", 2);
    expect(store.get("a/key")).toEqual("1");
    expect(store.get("b/key")).toEqual("2");
    expect(await nested.get<number>("key")).toEqual(2);
  });
});

describe("S3Repository map document", () => {
  it("supports insertOrUpdate/delete/truncate with versioning", async () => {
    useInMemoryBucket();
    const s3 = new S3Repository({
      bucketName: "test-bucket",
      prefix: "__test__/",
    });

    await s3.delete("map-doc");
    const mapDoc = s3.getMapDocument<string>("map-doc");

    const empty = await mapDoc.read();
    expect(empty.version).toEqual(0);
    expect(empty.content).toEqual({});

    await mapDoc.insertOrUpdate("hello", "world");
    const one = await mapDoc.read();
    expect(one.version).toEqual(1);
    expect(one.content).toEqual({ hello: "world" });

    await mapDoc.insertOrUpdate("hi", "world");
    const two = await mapDoc.read();
    expect(two.version).toEqual(2);
    expect(two.content).toEqual({ hello: "world", hi: "world" });

    await mapDoc.insertOrUpdate("hi", "there");
    const three = await mapDoc.read();
    expect(three.version).toEqual(3);
    expect(three.content).toEqual({ hello: "world", hi: "there" });

    await mapDoc.delete("hello");
    const oneAgain = await mapDoc.read();
    expect(oneAgain.version).toEqual(4);
    expect(oneAgain.content).toEqual({ hi: "there" });

    await mapDoc.truncate();
    const emptyAgain = await mapDoc.read();
    expect(emptyAgain.version).toEqual(0);
    expect(emptyAgain.content).toEqual({});
  });
});

describe("S3Repository list document", () => {
  interface KeyValue {
    key: string;
    value: string;
  }

  it("supports insert/deleteIf/truncate with versioning", async () => {
    useInMemoryBucket();
    const s3 = new S3Repository({
      bucketName: "test-bucket",
      prefix: "__test__/",
    });

    await s3.delete("list-doc");
    const listDoc = s3.getListDocument<KeyValue>("list-doc");

    const first = { key: "hello", value: "world" };
    const second = { key: "hi", value: "world" };
    const third = { key: "hi", value: "there" };

    const empty = await listDoc.read();
    expect(empty.version).toEqual(0);
    expect(empty.content).toEqual([]);

    await listDoc.insert(first);
    const one = await listDoc.read();
    expect(one.version).toEqual(1);
    expect(one.content).toEqual([first]);

    await listDoc.insert(second);
    const two = await listDoc.read();
    expect(two.version).toEqual(2);
    expect(two.content).toEqual([first, second]);

    await listDoc.insert(third);
    const three = await listDoc.read();
    expect(three.version).toEqual(3);
    expect(three.content).toEqual([first, second, third]);

    await listDoc.deleteIf((each) => each.value === "world");
    const oneAgain = await listDoc.read();
    expect(oneAgain.version).toEqual(4);
    expect(oneAgain.content).toEqual([third]);

    await listDoc.truncate();
    const emptyAgain = await listDoc.read();
    expect(emptyAgain.version).toEqual(0);
    expect(emptyAgain.content).toEqual([]);
  });
});
