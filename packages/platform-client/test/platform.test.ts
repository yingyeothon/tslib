import { describe, it, expect, vi } from "vitest";
import type { WebSocketConstructor } from "@yingyeothon/gamebase-client";
import { inspect } from "node:util";
import {
  createPlatformClient,
  createDeferredMatchClient,
  createLiveMatchClient,
  createPlatformPresenceClient,
} from "../src/index.js";
import type { PlatformFetchLike } from "../src/types.js";
import { createFakePlatform } from "../../../test-support/platform-fakes.js";
import { fakeResponse } from "../../../test-support/game-kit-fakes.js";
const A = "a".repeat(32),
  B = "b".repeat(32);
function fixture() {
  const f = createFakePlatform();
  const token = f.register(A);
  const client = createPlatformClient({
    baseUrl: "https://state.invalid",
    token,
    fetch: f.fetch,
  });
  return { f, client, token };
}
describe("platform wire", () => {
  it("reads server board periods, rankings and missing own score", async () => {
    const { f, client } = fixture();
    f.board("weekly");
    const b = client.board("weekly");
    expect(await b.me("weekly")).toBeUndefined();
    expect((await b.info()).periods).toHaveLength(3);
    expect(
      (await b.submit({ score: 40, meta: "value" })).periods.map(
        (s) => s.period,
      ),
    ).toEqual(["alltime", "daily", "weekly"]);
    expect(
      (await b.top({ period: "weekly", offset: 0, limit: 10 })).entries[0],
    ).toMatchObject({ owner: A, score: 40, rank: 1 });
    expect(await b.me("weekly")).toMatchObject({ score: 40, rank: 1 });
    await b.submit({ score: 20 });
    expect((await b.me("weekly"))?.score).toBe(40);
  });
  it("covers profile and relationship routes", async () => {
    const { f, client } = fixture();
    const token = f.register(B);
    const other = createPlatformClient({
      baseUrl: "https://state.invalid",
      token,
      fetch: f.fetch,
    });
    expect(await client.social.profile()).toBeUndefined();
    await client.social.setProfile({ displayName: "Alice" });
    await other.social.setProfile({
      displayName: "Bob",
      avatar: "https://avatar.invalid",
    });
    expect((await client.social.profiles([A, B])).map((p) => p.owner)).toEqual([
      A,
      B,
    ]);
    await client.social.request(B);
    expect((await other.social.requests()).incoming[0]?.owner).toBe(A);
    await other.social.accept(A);
    expect((await client.social.friends())[0]?.owner).toBe(B);
    await client.social.remove(B);
    expect(await client.social.friends()).toEqual([]);
    await client.social.request(B);
    await other.social.decline(A);
    expect((await other.social.requests()).incoming).toEqual([]);
    await other.social.block(A);
    await expect(client.social.request(B)).rejects.toMatchObject({
      status: 404,
    });
    await other.social.unblock(A);
    f.online.add(A);
    const presence = createPlatformPresenceClient({
      baseUrl: "https://gateway.invalid",
      channelId: "lobby",
      token,
      fetch: f.fetch,
    });
    expect(await presence.users([A, B])).toEqual([
      { userId: A, online: true },
      { userId: B, online: false },
    ]);
  });
  it("keeps time unauthenticated and requires credentials only on module use", async () => {
    const { f } = fixture();
    const client = createPlatformClient({
      baseUrl: "https://state.invalid",
      fetch: f.fetch,
    });
    expect((await client.time()).epochMs).toBeGreaterThan(0);
    await expect(client.social.profile()).rejects.toMatchObject({
      status: 401,
    });
  });
  it("validates inputs before HTTP", async () => {
    const { client } = fixture();
    for (const opts of [
      { period: "wrong" },
      { period: "daily", limit: 0 },
      { period: "daily", offset: 1001 },
    ])
      await expect(client.board("board").top(opts as never)).rejects.toThrow(
        RangeError,
      );
    await expect(client.board("board").submit({ score: 0.1 })).rejects.toThrow(
      RangeError,
    );
    await expect(
      client.board("board").submit({ score: 1, meta: "x".repeat(1025) }),
    ).rejects.toThrow(RangeError);
    await expect(client.social.profiles([])).rejects.toThrow(RangeError);
    await expect(client.social.profiles(["bad"])).rejects.toThrow(RangeError);
    await expect(client.social.setProfile({ displayName: "" })).rejects.toThrow(
      RangeError,
    );
    expect(() => client.board("../bad")).toThrow(RangeError);
    expect(() =>
      createPlatformClient({
        baseUrl: "https://state.invalid",
        token: "SECRET\n",
      }),
    ).toThrow(RangeError);
  });
  it("sanitizes body getters, network failures and malformed nested results", async () => {
    const fetch = vi.fn<PlatformFetchLike>(() =>
      Promise.resolve(fakeResponse(200, {})),
    );
    const client = createPlatformClient({
      baseUrl: "https://state.invalid",
      token: "fixture-token",
      fetch,
    });
    const input = Object.defineProperty({}, "displayName", {
      get() {
        throw new Error("PRIVATE-GETTER");
      },
    }) as { displayName: string };
    const e: unknown = await client.social
      .setProfile(input)
      .catch((e) => e as unknown);
    expect(inspect(e)).not.toContain("PRIVATE-GETTER");
    expect(fetch).not.toHaveBeenCalled();
    for (const run of [
      () => client.social.friends(),
      () => client.social.requests(),
      () => client.social.profiles([A]),
      () => client.board("b").info(),
      () => client.board("b").top({ period: "daily" }),
      () => client.board("b").submit({ score: 2 }),
      () => client.board("b").me("daily"),
    ])
      await expect(run()).rejects.toMatchObject({ code: "malformed_response" });
  });
  it("preserves retry seconds as milliseconds and drops arbitrary error text", async () => {
    const debug = vi.fn();
    const logger = {
      severity: "debug",
      debug,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as const;
    const fetch = () =>
      Promise.resolve(
        fakeResponse(429, {
          error: {
            code: "rate_limited",
            message: "PRIVATE",
            details: { reason: "cooldown", retryAfter: 3 },
          },
        }),
      );
    const c = createDeferredMatchClient({
      baseUrl: "https://match.invalid",
      channelId: "match",
      token: "fixture",
      fetch,
      logger,
    });
    const e: unknown = await c.submit().catch((e) => e as unknown);
    expect(e).toMatchObject({ retryAfterMs: 3000, reason: "cooldown" });
    expect(debug).toHaveBeenCalled();
    expect(inspect([e, debug.mock.calls], { depth: 8 })).not.toMatch(
      /PRIVATE|fixture/,
    );
    const bad = createPlatformClient({
      baseUrl: "https://state.invalid",
      token: "fixture",
      fetch: () =>
        Promise.resolve(
          fakeResponse(503, {
            error: { code: "PRIVATE", details: { reason: "PRIVATE" } },
          }),
        ),
    });
    await expect(bad.social.profile()).rejects.toMatchObject({
      code: "http_503",
      reason: undefined,
    });
  });
  it("handles all deferred states and idempotent cancellation", async () => {
    const { f, token } = fixture();
    const c = createDeferredMatchClient({
      baseUrl: "https://match.invalid",
      channelId: "match",
      token,
      fetch: f.fetch,
    });
    expect(await c.status()).toBeUndefined();
    expect((await c.submit()).state).toBe("waiting");
    for (const ticket of [
      {
        state: "proposed",
        matchId: "m",
        acceptBy: 1700000040,
        accepted: false,
        partial: false,
      },
      {
        state: "confirmed",
        matchId: "m",
        partial: false,
        result: null,
        members: [{ userId: A }],
        future: true,
      },
      { state: "expired", reason: "wait" },
      { state: "declined", matchId: "m" },
      { state: "failed", reason: "closed" },
    ]) {
      f.setTicket(A, ticket);
      expect(await c.status()).toMatchObject(ticket);
    }
    f.setTicket(A, {
      state: "proposed",
      matchId: "m",
      acceptBy: 1700000040,
      accepted: false,
      partial: false,
    });
    expect((await c.accept()).state).toBe("confirmed");
    f.setTicket(A, {
      state: "proposed",
      matchId: "m",
      acceptBy: 1700000040,
      accepted: false,
      partial: false,
    });
    expect((await c.decline()).state).toBe("declined");
    await c.cancel();
    await c.cancel();
    expect(await c.status()).toBeUndefined();
  });
  it.each([
    {},
    null,
    { state: "unknown" },
    { state: "waiting", position: "bad", waited: 1 },
    { state: "expired", reason: "bad" },
    {
      state: "confirmed",
      matchId: "m",
      partial: false,
      result: null,
      members: [{}],
    },
  ])("rejects malformed tickets", async (ticket) => {
    const c = createDeferredMatchClient({
      baseUrl: "https://match.invalid",
      channelId: "match",
      token: "fixture",
      fetch: () => Promise.resolve(fakeResponse(200, ticket)),
    });
    await expect(c.status()).rejects.toMatchObject({
      code: "malformed_response",
    });
  });
  it("live match carries JWT in subprotocol and preserves unknown result fields", async () => {
    const { f, token } = fixture();
    const c = createLiveMatchClient({
      url: "wss://match.invalid",
      channelId: "match",
      token,
      WebSocket: f.MatchWebSocket,
    });
    const task = c.find();
    expect(c.find()).toBe(task);
    f.match([A], { future: true });
    expect(await task).toMatchObject({
      result: null,
      members: [{ userId: A }],
      future: true,
    });
    const next = c.find();
    c.cancel();
    await expect(next).rejects.toMatchObject({ code: "cancelled" });
    expect(() =>
      createLiveMatchClient({
        url: "https://match.invalid",
        channelId: "match",
        token,
        WebSocket: f.MatchWebSocket,
      }),
    ).toThrow(RangeError);
  });
  it("live connection and malformed frame failures settle safely", async () => {
    let emit: (frame: unknown) => void = () => {};
    class Socket {
      readyState = 1;
      protocol = "bearer";
      addEventListener(type: string, fn: (event: never) => void) {
        if (type === "message") emit = (frame) => fn({ data: frame } as never);
      }
      send() {}
      close() {}
    }
    for (const value of [
      "not JSON",
      5,
      "{}",
      '{"type":"matched","members":[]}',
      '{"type":"failed","reason":"callback"}',
      '{"type":"replaced"}',
    ]) {
      const c = createLiveMatchClient({
        url: "ws://match.invalid",
        channelId: "match",
        token: "fixture",
        WebSocket: Socket,
      });
      const p = c.find();
      emit(value);
      await expect(p).rejects.toHaveProperty("name", "PlatformClientError");
    }
    const Throwing = function () {
      throw new Error("PRIVATE");
    } as unknown as WebSocketConstructor;
    await expect(
      createLiveMatchClient({
        url: "ws://match.invalid",
        channelId: "match",
        token: "fixture",
        WebSocket: Throwing,
      }).find(),
    ).rejects.toMatchObject({ code: "network" });
  });
});
