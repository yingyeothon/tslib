import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent, setGlobalDispatcher, type Interceptable } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createS3cbClient, type S3cbClientOptions } from "../src/index.js";

const origin = "http://api.test";
const env: S3cbClientOptions = {
  apiUrl: `${origin}/`,
  apiId: "test",
  apiPassword: "test",
};
// btoa("test:test")
const basicAuth = `Basic ${Buffer.from("test:test", "utf-8").toString("base64")}`;

let agent: MockAgent;
let pool: Interceptable;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  pool = agent.get(origin);
});

afterEach(async () => {
  agent.assertNoPendingInterceptors();
  await agent.close();
});

interface Captured {
  headers?: Record<string, string | string[] | undefined>;
  body?: string;
}

function intercept({
  method,
  path,
  status = 200,
  responseBody = "",
}: {
  method: string;
  path: string;
  status?: number;
  responseBody?: string | Buffer;
}): Captured {
  const captured: Captured = {};
  pool
    .intercept({
      method,
      path,
      body: (body) => {
        if (body !== undefined && body !== null) {
          captured.body =
            typeof body === "string"
              ? body
              : Buffer.from(body).toString("utf8");
        }
        return true;
      },
    })
    .reply(status, (opts) => {
      captured.headers = opts.headers as Captured["headers"];
      return responseBody;
    });
  return captured;
}

describe("get", () => {
  it("issues GET with noLock=0 and basic auth, returning the body text", async () => {
    const captured = intercept({
      method: "GET",
      path: "/hello?noLock=0",
      responseBody: "WORLD",
    });
    await expect(createS3cbClient(env).get("hello")).resolves.toEqual("WORLD");
    expect(captured.headers?.["Authorization"]).toEqual(basicAuth);
  });

  it("passes noLock=1 when requested", async () => {
    intercept({ method: "GET", path: "/hello?noLock=1", responseBody: "x" });
    await expect(
      createS3cbClient(env).get("hello", { noLock: true }),
    ).resolves.toEqual("x");
  });

  it("rejects with '404 Not Found' for a missing key", async () => {
    intercept({ method: "GET", path: "/hello?noLock=0", status: 404 });
    await expect(createS3cbClient(env).get("hello")).rejects.toThrow(
      /404 Not Found/,
    );
  });

  it("omits the Authorization header without credentials", async () => {
    const captured = intercept({
      method: "GET",
      path: "/hello?noLock=0",
      responseBody: "x",
    });
    await expect(
      createS3cbClient({ apiUrl: `${origin}/` }).get("hello"),
    ).resolves.toEqual("x");
    expect(captured.headers?.["Authorization"]).toBeUndefined();
  });

  it("round-trips multi-byte utf-8 content", async () => {
    const mbcs = Array(1024)
      .fill(0)
      .map(() => "안녕")
      .join("");
    intercept({
      method: "GET",
      path: "/mbcs?noLock=0",
      responseBody: Buffer.from(mbcs, "utf8"),
    });
    await expect(createS3cbClient(env).get("mbcs")).resolves.toEqual(mbcs);
  });
});

describe("put", () => {
  it("issues PUT with noLock=0&sync=0 and a utf-8 body from a string", async () => {
    const captured = intercept({
      method: "PUT",
      path: "/hello?noLock=0&sync=0",
      responseBody: "ok",
    });
    await expect(
      createS3cbClient(env).put("hello", "안녕WORLD"),
    ).resolves.toEqual("ok");
    expect(captured.body).toEqual("안녕WORLD");
    expect(captured.headers?.["Authorization"]).toEqual(basicAuth);
  });

  it("sends a Buffer body as-is", async () => {
    const captured = intercept({
      method: "PUT",
      path: "/binkey?noLock=0&sync=0",
      responseBody: "ok",
    });
    const buffer = Buffer.from("SOMETHING SPECIAL", "utf8");
    await expect(createS3cbClient(env).put("binkey", buffer)).resolves.toEqual(
      "ok",
    );
    expect(captured.body).toEqual("SOMETHING SPECIAL");
  });

  it("passes noLock and sync flags", async () => {
    intercept({
      method: "PUT",
      path: "/hello?noLock=1&sync=1",
      responseBody: "ok",
    });
    await expect(
      createS3cbClient(env).put("hello", "x", { noLock: true, sync: true }),
    ).resolves.toEqual("ok");
  });

  it("rejects on a non-200 status", async () => {
    intercept({
      method: "PUT",
      path: "/hello?noLock=0&sync=0",
      status: 500,
    });
    await expect(createS3cbClient(env).put("hello", "x")).rejects.toThrow(
      /500 Internal Server Error/,
    );
  });
});

describe("del", () => {
  it("issues DELETE with noLock=0", async () => {
    const captured = intercept({
      method: "DELETE",
      path: "/hello?noLock=0",
      responseBody: "deleted",
    });
    await expect(createS3cbClient(env).del("hello")).resolves.toEqual(
      "deleted",
    );
    expect(captured.headers?.["Authorization"]).toEqual(basicAuth);
  });

  it("passes noLock=1 when requested", async () => {
    intercept({
      method: "DELETE",
      path: "/hello?noLock=1",
      responseBody: "deleted",
    });
    await expect(
      createS3cbClient(env).del("hello", { noLock: true }),
    ).resolves.toEqual("deleted");
  });
});

describe("append", () => {
  it("issues PUT with append=1&noLock=0&sync=0 and the body", async () => {
    const captured = intercept({
      method: "PUT",
      path: "/hello?append=1&noLock=0&sync=0",
      responseBody: "appended",
    });
    await expect(
      createS3cbClient(env).append("hello", "MORE"),
    ).resolves.toEqual("appended");
    expect(captured.body).toEqual("MORE");
  });

  it("passes noLock and sync flags", async () => {
    intercept({
      method: "PUT",
      path: "/hello?append=1&noLock=1&sync=1",
      responseBody: "appended",
    });
    await expect(
      createS3cbClient(env).append("hello", "MORE", {
        noLock: true,
        sync: true,
      }),
    ).resolves.toEqual("appended");
  });
});

describe("sync", () => {
  it("issues POST with sync=1", async () => {
    intercept({ method: "POST", path: "/hello?sync=1", responseBody: "ok" });
    await expect(createS3cbClient(env).sync("hello")).resolves.toEqual("ok");
  });
});

describe("invalidate", () => {
  it("issues DELETE with cache=1", async () => {
    intercept({
      method: "DELETE",
      path: "/hello?cache=1",
      responseBody: "ok",
    });
    await expect(createS3cbClient(env).invalidate("hello")).resolves.toEqual(
      "ok",
    );
  });
});

describe("lock and unlock", () => {
  it("acquires a lock via POST lock=acquire", async () => {
    const captured = intercept({
      method: "POST",
      path: "/hello?lock=acquire",
      responseBody: "locked",
    });
    await expect(createS3cbClient(env).lock("hello")).resolves.toEqual(
      "locked",
    );
    expect(captured.headers?.["Authorization"]).toEqual(basicAuth);
  });

  it("releases a lock via POST lock=release", async () => {
    intercept({
      method: "POST",
      path: "/hello?lock=release",
      responseBody: "unlocked",
    });
    await expect(createS3cbClient(env).unlock("hello")).resolves.toEqual(
      "unlocked",
    );
  });

  it("rejects when the lock is already held", async () => {
    intercept({ method: "POST", path: "/hello?lock=acquire", status: 409 });
    await expect(createS3cbClient(env).lock("hello")).rejects.toThrow(
      /409 Conflict/,
    );
  });

  it("supports a full lock, mutate, unlock flow", async () => {
    intercept({
      method: "POST",
      path: "/hello?lock=acquire",
      responseBody: "locked",
    });
    intercept({
      method: "PUT",
      path: "/hello?noLock=1&sync=0",
      responseBody: "stored",
    });
    intercept({
      method: "POST",
      path: "/hello?lock=release",
      responseBody: "unlocked",
    });
    const cb = createS3cbClient(env);
    await expect(cb.lock("hello")).resolves.toEqual("locked");
    await expect(cb.put("hello", "x", { noLock: true })).resolves.toEqual(
      "stored",
    );
    await expect(cb.unlock("hello")).resolves.toEqual("unlocked");
  });
});

describe("patch", () => {
  it("sends the modification request and returns null without fetch", async () => {
    const captured = intercept({
      method: "PATCH",
      path: "/mod?noLock=0&sync=0&fetch=0",
      responseBody: "",
    });
    await expect(
      createS3cbClient(env).patch("mod", {
        operation: "append",
        path: "a.b",
        value: { c: 10 },
        upsert: true,
      }),
    ).resolves.toBeNull();
    expect(JSON.parse(captured.body ?? "")).toEqual({
      operation: "append",
      path: "a.b",
      value: { c: 10 },
      upsert: true,
    });
  });

  it("parses the fetched result when fetch is requested", async () => {
    intercept({
      method: "PATCH",
      path: "/mod?noLock=0&sync=0&fetch=1",
      responseBody: JSON.stringify({
        _ok: true,
        result: { a: { b: { c: 10 } } },
      }),
    });
    await expect(
      createS3cbClient(env).patch(
        "mod",
        { operation: "modify", path: "a.b", value: { c: 10 } },
        { fetch: true },
      ),
    ).resolves.toEqual({ a: { b: { c: 10 } } });
  });

  it("defaults fetch to true for the fetch operation", async () => {
    intercept({
      method: "PATCH",
      path: "/mod?noLock=0&sync=0&fetch=1",
      responseBody: JSON.stringify({ _ok: true, result: { b: { c: 20 } } }),
    });
    await expect(
      createS3cbClient(env).patch("mod", { operation: "fetch", path: "a" }),
    ).resolves.toEqual({ b: { c: 20 } });
  });

  it("passes noLock and sync flags", async () => {
    intercept({
      method: "PATCH",
      path: "/mod?noLock=1&sync=1&fetch=0",
      responseBody: "",
    });
    await expect(
      createS3cbClient(env).patch(
        "mod",
        { operation: "remove", path: "a.b" },
        { noLock: true, sync: true },
      ),
    ).resolves.toBeNull();
  });

  it("throws the server error when the modification fails", async () => {
    intercept({
      method: "PATCH",
      path: "/mod?noLock=0&sync=0&fetch=1",
      responseBody: JSON.stringify({ _ok: false, error: "invalid path" }),
    });
    await expect(
      createS3cbClient(env).patch("mod", { operation: "fetch", path: "a" }),
    ).rejects.toThrow(/invalid path/);
  });

  it("rejects on a non-200 status", async () => {
    intercept({
      method: "PATCH",
      path: "/mod?noLock=0&sync=0&fetch=1",
      status: 400,
    });
    await expect(
      createS3cbClient(env).patch("mod", { operation: "fetch", path: "a" }),
    ).rejects.toThrow(/400 Bad Request/);
  });
});

describe("getBuffer", () => {
  it("returns the raw bytes as a Buffer", async () => {
    const bytes = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x80]);
    intercept({
      method: "GET",
      path: "/binkey?noLock=0",
      responseBody: bytes,
    });
    const result = await createS3cbClient(env).getBuffer("binkey");
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.equals(bytes)).toBe(true);
  });

  it("rejects with '404 Not Found' for a missing key", async () => {
    intercept({ method: "GET", path: "/binkey?noLock=0", status: 404 });
    await expect(createS3cbClient(env).getBuffer("binkey")).rejects.toThrow(
      /404 Not Found/,
    );
  });
});

describe("download", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "s3cb-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("streams the response into the given file and resolves the path", async () => {
    intercept({
      method: "GET",
      path: "/binkey?noLock=0",
      responseBody: "SOMETHING SPECIAL",
    });
    const downloadPath = join(tempDir, "binkey-test");
    await expect(
      createS3cbClient(env).download("binkey", downloadPath),
    ).resolves.toEqual(downloadPath);
    expect(readFileSync(downloadPath, "utf8")).toEqual("SOMETHING SPECIAL");
  });

  it("rejects with '404 Not Found' for a missing key", async () => {
    intercept({ method: "GET", path: "/binkey?noLock=0", status: 404 });
    await expect(
      createS3cbClient(env).download("binkey", join(tempDir, "missing")),
    ).rejects.toThrow(/404 Not Found/);
  });
});

describe("exists", () => {
  it("returns true when the HEAD request succeeds", async () => {
    intercept({ method: "HEAD", path: "/hello?noLock=0" });
    await expect(createS3cbClient(env).exists("hello")).resolves.toBe(true);
  });

  it("returns false when the key does not exist", async () => {
    intercept({ method: "HEAD", path: "/hello?noLock=0", status: 404 });
    await expect(createS3cbClient(env).exists("hello")).resolves.toBe(false);
  });

  it("rethrows non-404 errors", async () => {
    intercept({ method: "HEAD", path: "/hello?noLock=0", status: 500 });
    await expect(createS3cbClient(env).exists("hello")).rejects.toThrow(
      /500 Internal Server Error/,
    );
  });

  it("passes noLock=1 when requested", async () => {
    intercept({ method: "HEAD", path: "/hello?noLock=1" });
    await expect(
      createS3cbClient(env).exists("hello", { noLock: true }),
    ).resolves.toBe(true);
  });
});
