import { describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import { createPushServer, isPushServerError } from "../src/index.js";
import type {
  PushServerFetchLike,
  PushServerOptions,
  PushBroadcastOptions,
  PushListJobsOptions,
} from "../src/index.js";
import { createFakePushServer } from "../../../test-support/push-fakes.js";
const options = {
  stateBaseUrl: "https://state.test",
  consoleBaseUrl: "https://console.test/",
  channelId: "push_1",
  apiKey: "server-key",
};
const reply = (status: number, body: unknown) => ({
  status,
  headers: { get: () => null },
  text: () =>
    Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
});
const server = (overrides: Partial<PushServerOptions> = {}) =>
  createPushServer({ ...options, ...overrides });
describe("server push", () => {
  it("uses separate hosts and leaves object URLs to the caller", async () => {
    const fake = createFakePushServer();
    const s = server({ fetch: fake.fetch });
    const upload = await s.createUpload({ size: 20, sha256: "a".repeat(64) });
    expect(upload.method).toBe("PUT");
    expect(upload.headers["content-length"]).toBe("20");
    fake.putUpload(upload.uploadId, ["alice"]);
    expect(
      (await s.listUploads({ limit: 1, cursor: "cursor +/&" })).uploads[0]?.id,
    ).toBe(upload.uploadId);
    const input = {
      templateId: "pt_1",
      uploadId: upload.uploadId,
      idempotencyKey: "run-1",
      dryRun: true,
    };
    const first = await s.submitJob(input);
    const repeated = await s.submitJob(input);
    expect(first.created).toBe(true);
    expect(repeated).toEqual({ ...first, created: false });
    expect(await s.getJob(first.job.id)).toEqual(first.job);
    expect(await s.cancelJob(first.job.id)).toEqual(first.job);
    expect(fake.calls.at(-1)).toMatchObject({
      url: `https://console.test/push-api/push_1/jobs/${first.job.id}/cancel`,
      request: { method: "POST" },
    });
    expect((await s.listJobs()).jobs).toHaveLength(1);
    expect((await s.listJobs({ idempotencyKey: "run-1" })).jobs).toHaveLength(
      1,
    );
    expect((await s.listJobs({ idempotencyKey: "absent" })).jobs).toEqual([]);
    expect((await s.getReportUrl(first.job.id)).url).toContain("objects.test");
    await s.deleteUpload(upload.uploadId);
    expect((await s.listUploads()).uploads).toEqual([]);
    expect((await s.submitJob(input)).created).toBe(false);
    await expect(
      s.submitJob({ ...input, dryRun: false }),
    ).rejects.toMatchObject({ reason: "idempotency_key_reused" });
    const broadcast = await s.broadcast({
      idempotencyKey: "broadcast-1",
      title: "Hello",
      body: "World",
      data: { kind: "news" },
    });
    expect(broadcast.job.kind).toBe("broadcast");
    expect(
      (await s.broadcast({ idempotencyKey: "broadcast-2", templateId: "pt_1" }))
        .created,
    ).toBe(true);
    expect(
      fake.calls.every((c) => c.url.startsWith("https://console.test/")),
    ).toBe(true);
    expect(fake.calls.find((c) => c.url.includes("cursor="))?.url).toContain(
      "cursor=cursor+%2B%2F%26",
    );
  });
  it("does not retry partial failures or interpret sent as device receipt", async () => {
    const fetch = vi.fn<PushServerFetchLike>().mockResolvedValue(
      reply(200, {
        results: [
          { userId: "a", status: "sent" },
          { userId: "b", status: "no-token" },
          { userId: "c", status: "failed", reason: "budget" },
          { userId: "d", status: "failed", reason: "unavailable" },
          { userId: "e", status: "failed", reason: "rejected" },
          { userId: "f", status: "failed", reason: "unregistered" },
        ],
        sent: 1,
        noToken: 1,
        failed: 4,
      }),
    );
    const result = await server({ fetch }).send({
      userIds: ["a", "b", "c", "d", "e", "f"],
      data: { kind: "invite" },
      priority: "high",
      ttlSec: 600,
      collapseKey: "invite",
    });
    expect(result.failed).toBe(4);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://state.test/push/push_1/send",
    );
    expect(JSON.parse(fetch.mock.calls[0]![1].body!)).toMatchObject({
      priority: "high",
      ttlSec: 600,
      collapseKey: "invite",
    });
  });
  it.each([[], Array(501).fill("a"), [""], [5]])(
    "rejects invalid recipient lists",
    async (userIds) =>
      await expect(
        server().send({ userIds: userIds as string[], data: { kind: "x" } }),
      ).rejects.toThrow("userIds"),
  );
  it.each([
    { priority: "fast" },
    { ttlSec: -1 },
    { ttlSec: 2419201 },
    { collapseKey: "" },
    { collapseKey: "has space" },
  ])(
    "rejects invalid delivery options",
    async (fields) =>
      await expect(
        server().send({
          userIds: ["a"],
          data: { kind: "x" },
          ...fields,
        } as Parameters<ReturnType<typeof server>["send"]>[0]),
      ).rejects.toThrow("delivery"),
  );
  it.each([
    {},
    { data: { from: "bad" } },
    { data: { "google.foo": "bad" } },
    { data: { "gcm.foo": "bad" } },
    { data: { "": "bad" } },
    { data: { a: 5 } },
    { notification: { title: "", body: "" } },
    {
      data: Object.fromEntries(
        Array.from({ length: 65 }, (_, i) => [String(i), "x"]),
      ),
    },
  ])(
    "rejects invalid messages",
    async (fields) =>
      await expect(
        server().send({ userIds: ["a"], ...fields } as Parameters<
          ReturnType<typeof server>["send"]
        >[0]),
      ).rejects.toThrow(),
  );
  it.each([
    { size: 0 },
    { size: 102401025 },
    { size: 1, sha256: "A".repeat(64) },
  ])(
    "rejects invalid uploads",
    async (value) =>
      await expect(server().createUpload(value)).rejects.toThrow("upload"),
  );
  it("rejects invalid job and pagination inputs", async () => {
    const s = server();
    await expect(
      s.submitJob({
        templateId: "bad/path",
        uploadId: "pu_1",
        idempotencyKey: "k",
      }),
    ).rejects.toThrow("identifier");
    await expect(
      s.submitJob({ templateId: "pt_1", uploadId: "pu_1", idempotencyKey: "" }),
    ).rejects.toThrow("idempotency");
    await expect(
      s.submitJob({
        templateId: "pt_1",
        uploadId: "pu_1",
        idempotencyKey: "k",
        dryRun: 5 as unknown as boolean,
      }),
    ).rejects.toThrow("dryRun");
    for (const value of [
      { limit: 0 },
      { limit: 101 },
      { cursor: "" },
      { idempotencyKey: "k", limit: 1 },
    ])
      await expect(s.listJobs(value as PushListJobsOptions)).rejects.toThrow();
    await expect(s.getJob("../bad")).rejects.toThrow("identifier");
  });
  it("rejects invalid inline/template combinations", async () => {
    for (const fields of [
      { templateId: "pt_1", title: "Hi" },
      { body: "Hi" },
      { title: 1 },
      { body: 1 },
      {},
    ])
      await expect(
        server().broadcast({
          idempotencyKey: "k",
          ...fields,
        } as PushBroadcastOptions),
      ).rejects.toThrow();
  });
  it("rejects malformed successful responses for every method", async () => {
    const s = server({
      fetch: (_url, request) =>
        Promise.resolve(reply(request.method === "POST" ? 201 : 200, {})),
    });
    await expect(s.createUpload({ size: 1 })).rejects.toMatchObject({
      code: "malformed_response",
      status: 201,
    });
    const s2 = server({ fetch: () => Promise.resolve(reply(200, {})) });
    for (const run of [
      () => s2.send({ userIds: ["a"], data: { kind: "x" } }),
      () => s2.listUploads(),
      () => s2.listJobs(),
      () => s2.getJob("j"),
      () => s2.cancelJob("j"),
      () => s2.getReportUrl("j"),
      () =>
        s2.submitJob({ templateId: "t", uploadId: "u", idempotencyKey: "k" }),
      () => s2.broadcast({ idempotencyKey: "k", data: { kind: "x" } }),
    ])
      await expect(run()).rejects.toMatchObject({ code: "malformed_response" });
  });
  it.each(["file:///tmp", "https://secret:private@host", "broken"])(
    "rejects unsafe returned URLs",
    async (url) =>
      await expect(
        server({
          fetch: () =>
            Promise.resolve(
              reply(200, { url, expiresAt: 1, reportExpiresAt: 2 }),
            ),
        }).getReportUrl("j"),
      ).rejects.toMatchObject({ code: "malformed_response" }),
  );
  it("sanitizes JSON, network and unexpected errors with no resend", async () => {
    for (const fetch of [
      vi.fn().mockRejectedValue(new Error("SECRET")),
      vi.fn().mockResolvedValue(reply(200, "SECRET-not-json")),
      vi.fn().mockResolvedValue(
        reply(503, {
          error: {
            code: "SECRET",
            message: "SECRET",
            details: { reason: "SECRET" },
          },
        }),
      ),
    ]) {
      let caught: unknown;
      try {
        await server({ fetch }).send({ userIds: ["a"], data: { kind: "x" } });
      } catch (e) {
        caught = e;
      }
      expect(isPushServerError(caught)).toBe(true);
      expect(inspect(caught, { depth: 8 })).not.toContain("SECRET");
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it("sanitizes serialization exceptions", async () => {
    const userIds = Object.assign(["a"], {
      toJSON() {
        throw new Error("SECRET-ENCODER");
      },
    });
    const fetch = vi.fn();
    await expect(
      server({ fetch }).send({ userIds, data: { kind: "x" } }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves known reasons and safe retry timing without retaining error bodies", async () => {
    const debug = vi.fn();
    const logger = {
      debug,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      severity: 0,
    } as unknown as NonNullable<PushServerOptions["logger"]>;
    const fetch = vi.fn().mockResolvedValue(
      reply(429, {
        error: {
          code: "rate_limited",
          message: "SECRET",
          details: { reason: "push_upload_cap", retryAfterMs: 500 },
        },
      }),
    );
    let caught: unknown;
    try {
      await server({ fetch, logger }).createUpload({ size: 1 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({
      status: 429,
      code: "rate_limited",
      reason: "push_upload_cap",
      retryAfterMs: 500,
    });
    expect(debug).toHaveBeenCalled();
    expect(inspect([caught, debug.mock.calls], { depth: 8 })).not.toMatch(
      /SECRET|server-key/,
    );
  });
  it("retains actual HTTP status for malformed new job submissions", async () => {
    const s = server({ fetch: () => Promise.resolve(reply(202, {})) });
    await expect(
      s.submitJob({ templateId: "t", uploadId: "u", idempotencyKey: "k" }),
    ).rejects.toMatchObject({ status: 202, code: "malformed_response" });
    await expect(
      s.broadcast({ idempotencyKey: "k", data: { kind: "news" } }),
    ).rejects.toMatchObject({ status: 202, code: "malformed_response" });
  });
  it("preserves the upload_expired reason", async () => {
    await expect(
      server({
        fetch: () =>
          Promise.resolve(
            reply(409, {
              error: {
                code: "conflict",
                details: { reason: "upload_expired" },
              },
            }),
          ),
      }).submitJob({ templateId: "t", uploadId: "u", idempotencyKey: "k" }),
    ).rejects.toMatchObject({ status: 409, reason: "upload_expired" });
  });
  it("sanitizes getters throughout message validation and copying", async () => {
    const fetch = vi.fn();
    const debug = vi.fn();
    const logger = {
      debug,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      severity: 0,
    } as unknown as NonNullable<PushServerOptions["logger"]>;
    const s = server({ fetch, logger });
    const secret = () => {
      throw new RangeError("PRIVATE-GETTER");
    };
    const data = Object.defineProperty({}, "kind", {
      get: secret,
      enumerable: true,
    }) as Record<string, string>;
    const notification = Object.defineProperty({ body: "ok" }, "title", {
      get: secret,
      enumerable: true,
    }) as { title: string; body: string };
    for (const run of [
      () => s.send({ userIds: ["a"], data }),
      () => s.send({ userIds: ["a"], notification }),
      () => s.broadcast({ idempotencyKey: "k", data }),
    ]) {
      let error: unknown;
      try {
        await run();
      } catch (e) {
        error = e;
      }
      expect(error).toMatchObject({ code: "invalid_request" });
      expect(inspect([error, debug.mock.calls], { depth: 8 })).not.toContain(
        "PRIVATE-GETTER",
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("aborts a stalled send within the configured budget without retrying", async () => {
    let aborted = false;
    const fetch = vi.fn<PushServerFetchLike>(
      (_url, request) =>
        new Promise((_resolve, reject) => {
          if (!request.signal) throw new Error("missing request signal");
          request.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("PRIVATE-TIMEOUT"));
            },
            { once: true },
          );
        }),
    );
    await expect(
      server({ fetch, timeoutMs: 10 }).send({
        userIds: ["a"],
        data: { kind: "x" },
      }),
    ).rejects.toMatchObject({ status: 0, code: "network" });
    expect(aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("validates factories and guard shape", () => {
    for (const change of [
      { stateBaseUrl: "broken" },
      { consoleBaseUrl: "ftp://host" },
      { consoleBaseUrl: "https://host?key=secret" },
      { channelId: "../bad" },
      { apiKey: "secret\n" },
      { timeoutMs: -1 },
    ])
      expect(() => server(change)).toThrow(RangeError);
    for (const v of [null, {}, 1, { name: "PushServerError", status: 0 }])
      expect(isPushServerError(v)).toBe(false);
    vi.stubGlobal("fetch", undefined);
    try {
      expect(() => server()).toThrow("No fetch");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
