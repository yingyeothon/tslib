import { describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import { createPushClient, isPushClientError } from "../src/index.js";
import type { PushClientOptions, PushClientFetchLike } from "../src/index.js";
import { createFakePushServer } from "../../../test-support/push-fakes.js";
const options = {
  baseUrl: "https://state.test/",
  channelId: "push_1",
  token: "player-alice",
};
const reply = (status: number, body = "", retry: string | null = null) => ({
  status,
  headers: { get: () => retry },
  text: () => Promise.resolve(body),
});
function client(overrides: Partial<PushClientOptions> = {}) {
  return createPushClient({ ...options, ...overrides });
}
describe("push token client", () => {
  it("registers and removes only the current player's token", async () => {
    const fake = createFakePushServer();
    const alice = client({ fetch: fake.fetch });
    await alice.register({ token: "fcm-1", project: "firebase-project" });
    await client({ token: "player-bob", fetch: fake.fetch }).unregister({
      token: "fcm-1",
    });
    const send = async () =>
      JSON.parse(
        await (
          await fake.fetch("https://state.test/push/push_1/send", {
            method: "POST",
            headers: { Authorization: "Bearer server-key" },
            body: JSON.stringify({ userIds: ["alice"] }),
          })
        ).text(),
      ) as { sent: number; noToken: number };
    expect(await send()).toMatchObject({ sent: 1, noToken: 0 });
    await alice.unregister({ token: "fcm-1" });
    expect(await send()).toMatchObject({ sent: 0, noToken: 1 });
    await alice.unregister({ token: "fcm-1" });
    expect(
      fake.calls
        .filter((c) => c.url.endsWith("/token"))
        .map((c) => c.request.method),
    ).toEqual(["PUT", "DELETE", "DELETE", "DELETE"]);
    expect(fake.calls[0]).toMatchObject({
      url: "https://state.test/push/push_1/token",
      request: {
        headers: { Authorization: "Bearer player-alice" },
        body: JSON.stringify({ token: "fcm-1", project: "firebase-project" }),
      },
    });
  });
  it("does not add project or unknown fields when omitted", async () => {
    const fake = createFakePushServer();
    await client({ fetch: fake.fetch }).register({
      token: "fcm-1",
      secret: "ignored",
    } as { token: string });
    expect(fake.calls[0]?.request.body).toBe('{"token":"fcm-1"}');
  });
  it.each([
    "broken",
    "file:///tmp",
    "https://user:secret@host",
    "https://host?a=1",
    "https://host/#a",
  ])("refuses unsafe URL %s", (baseUrl) =>
    expect(() => client({ baseUrl })).toThrow("push base URL"),
  );
  it.each(["", "../bad", "a/b", "bad\nvalue"])(
    "rejects unsafe channel ids",
    (channelId) => expect(() => client({ channelId })).toThrow("identifier"),
  );
  it.each(["", "secret\nvalue", "Bearer secret", "secret\u0000value"])(
    "rejects credentials without echoing them",
    (token) => {
      try {
        client({ token });
        throw new Error("accepted");
      } catch (e) {
        expect(inspect(e)).not.toContain("secret");
        expect(e).toBeInstanceOf(RangeError);
      }
    },
  );
  it.each(["", "a b", "a\n", "x".repeat(513)])(
    "rejects invalid FCM token",
    async (token) => {
      const fetch = vi.fn();
      await expect(client({ fetch }).register({ token })).rejects.toThrow(
        "registration token",
      );
      await expect(client({ fetch }).unregister({ token })).rejects.toThrow(
        "registration token",
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each(["", "a b", "a".repeat(65), "Project_ID", "bad.project"])(
    "rejects invalid project",
    async (project) =>
      await expect(
        client().register({ token: "fcm", project }),
      ).rejects.toThrow("project"),
  );
  it("sanitizes network errors and performs no retry", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("PRIVATE-CREDENTIAL"));
    await expect(
      client({ fetch }).register({ token: "fcm" }),
    ).rejects.toMatchObject({
      name: "PushClientError",
      status: 0,
      code: "network",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("reports known errors, retry timing, and logs only status", async () => {
    const debug = vi.fn();
    const logger = {
      debug,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      severity: 0,
    } as unknown as NonNullable<PushClientOptions["logger"]>;
    const fetch = vi.fn().mockResolvedValue(
      reply(
        429,
        JSON.stringify({
          error: {
            code: "rate_limited",
            message: "PRIVATE-MESSAGE",
            details: {
              reason: "push_project_required",
              retryAfterMs: 500,
              token: "PRIVATE-TOKEN",
            },
          },
        }),
      ),
    );
    let caught: unknown;
    try {
      await client({ fetch, logger }).register({ token: "PRIVATE-TOKEN" });
    } catch (e) {
      caught = e;
    }
    expect(isPushClientError(caught)).toBe(true);
    expect(caught).toMatchObject({
      status: 429,
      code: "rate_limited",
      reason: "push_project_required",
      retryAfterMs: 500,
    });
    expect(debug).toHaveBeenCalledWith("push request completed", {
      method: "PUT",
      status: 429,
    });
    expect(inspect([caught, debug.mock.calls], { depth: 8 })).not.toMatch(
      /PRIVATE|player-alice/,
    );
  });
  it("ignores arbitrary error fields and handles empty throttle body", async () => {
    for (const body of [
      "",
      "not json",
      '{"error":{"code":"SECRET-CODE","details":{"reason":"SECRET-REASON"}}}',
      '{"error":"SECRET"}',
    ]) {
      await expect(
        client({
          fetch: () => Promise.resolve(reply(503, body, "2")),
        }).register({
          token: "fcm",
        }),
      ).rejects.toMatchObject({
        status: 503,
        code: "http_503",
        reason: undefined,
        retryAfterMs: 2000,
      });
    }
  });
  it("handles invalid retry timing safely", async () => {
    await expect(
      client({
        fetch: () =>
          Promise.resolve(
            reply(429, '{"error":{"details":{"retryAfterMs":-1}}}', "bad"),
          ),
      }).register({ token: "fcm" }),
    ).rejects.toMatchObject({ retryAfterMs: undefined });
    await expect(
      client({
        fetch: () => Promise.resolve(reply(429, "", "9".repeat(400))),
      }).register({
        token: "fcm",
      }),
    ).rejects.toMatchObject({ retryAfterMs: undefined });
  });
  it("rejects invalid timeout and a missing fetch implementation", () => {
    expect(() => client({ timeoutMs: 0 })).toThrow("timeoutMs");
    vi.stubGlobal("fetch", undefined);
    try {
      expect(() => client()).toThrow("No fetch");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("captures credential at construction and disallows redirects", async () => {
    const config = {
      ...options,
      fetch: vi.fn<PushClientFetchLike>().mockResolvedValue(reply(204)),
      timeoutMs: 10,
    };
    const c = client(config);
    config.token = "changed";
    await c.register({ token: "fcm" });
    expect(config.fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer player-alice" },
      redirect: "error",
    });
    expect(config.fetch.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });
  it("sanitizes caller getters before sending", async () => {
    const fetch = vi.fn();
    const input = Object.defineProperty({}, "token", {
      get() {
        throw new Error("PRIVATE-GETTER");
      },
    }) as { token: string };
    await expect(client({ fetch }).register(input)).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("recognizes only errors with the required shape", () => {
    for (const v of [
      null,
      1,
      {},
      { name: "PushClientError" },
      { name: "PushClientError", status: 0, code: 5 },
    ])
      expect(isPushClientError(v)).toBe(false);
  });
});
