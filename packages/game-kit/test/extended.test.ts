import { fakeResponse } from "../../../test-support/game-kit-fakes.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGameKit,
  type GameKit,
  type GameKitOptions,
} from "../src/index.js";
import type { WebSocketConstructor } from "@yingyeothon/gamebase-client";
import { createFakePlatform } from "../../../test-support/platform-fakes.js";
import { createFakeScheduler } from "../../../test-support/game-kit-fakes.js";
const A = "a".repeat(32),
  B = "b".repeat(32),
  C = "c".repeat(32),
  D = "d".repeat(32);
const kits: GameKit[] = [];
afterEach(async () => {
  for (const kit of kits.splice(0)) {
    await kit.session.signOut();
    kit.dispose();
  }
});
async function drain() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
function fixture() {
  const scheduler = createFakeScheduler();
  const fake = createFakePlatform(() => 1700000000000 + scheduler.now());
  fake.state.collection("mail", "user", "project");
  fake.state.collection("save", "user", "user");
  fake.board("weekly");
  fake.board("server", { submit: "server" });
  const WebSocket = function (url: string, protocols: string[]) {
    return new (
      url.includes("match.invalid")
        ? fake.MatchWebSocket
        : fake.gateway.WebSocket
    )(url, protocols);
  } as unknown as WebSocketConstructor;
  function kit(id: string, options: Partial<GameKitOptions> = {}) {
    const token = fake.register(id);
    const k = createGameKit({
      config: {
        auth: { url: "https://auth.invalid", channelId: "ch" },
        state: { url: "https://state.invalid" },
        gateway: { url: "wss://gateway.invalid", lobbyChannelId: "lobby" },
        collections: { mail: "mail", save: "save" },
        boards: { weekly: "weekly", server: "server" },
        match: {
          mode: "deferred",
          apiBase: "https://match.invalid",
          channelId: "match",
          ticketUrl: "https://match.invalid/m/match/ticket",
        },
        push: {
          channelId: "push",
          apiBase: "https://state.invalid",
          topic: "configured.topic",
        },
      },
      fetch: fake.fetch,
      scheduler,
      WebSocket,
      ...options,
    });
    kits.push(k);
    return { kit: k, token, signIn: () => k.session.fromToken(token) };
  }
  return { fake, scheduler, kit };
}
describe("shared scenarios 5–10", () => {
  it("5: board submit returns all periods, server-only refuses, around clamps", async () => {
    const f = fixture();
    const a = f.kit(A);
    await a.signIn();
    const board = await a.kit.board("weekly");
    expect((await board.submit({ score: 20 })).map((s) => s.period)).toEqual([
      "alltime",
      "daily",
      "weekly",
    ]);
    expect(
      (await board.around({ period: "weekly", span: 2 })).entries[0]?.rank,
    ).toBe(1);
    expect(await board.me("weekly")).toEqual({ score: 20, rank: 1, total: 1 });
    expect(board.rule).toBe("best");
    await expect(
      (await a.kit.board("server")).submit({ score: 1 }),
    ).rejects.toMatchObject({ code: "server_only" });
    const b = f.kit(B);
    await b.signIn();
    expect(
      (
        await (
          await b.kit.board("weekly")
        ).around({ period: "weekly", span: 1 })
      ).entries,
    ).toEqual([]);
    await expect(board.around({ period: "weekly", span: 50 })).rejects.toThrow(
      RangeError,
    );
  });
  it("6: exactly one claim succeeds, server stamps survive and arrived emits once", async () => {
    const f = fixture();
    const a = f.kit(A);
    await a.signIn();
    f.fake.state.seed("mail", "gift", { coins: 5 }, A);
    const arrived: string[] = [];
    a.kit.mail.on("arrived", (letter) => arrived.push(letter.id));
    await drain();
    expect(arrived).toEqual(["gift"]);
    f.scheduler.advance(30000);
    await drain();
    expect(arrived).toEqual(["gift"]);
    const claims = await Promise.allSettled([
      a.kit.mail.claim("gift"),
      a.kit.mail.claim("gift"),
    ]);
    expect(claims.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(claims.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "already_claimed" },
    });
    expect(await a.kit.mail.read("gift")).toBeUndefined();
    await a.kit.mail.remove("gift");
    const b = f.kit(B);
    await b.signIn();
    await b.kit.mail.send({ to: A, value: { hello: true }, ttl: 60 });
    const letters = await a.kit.mail.list();
    expect(letters[0]).toMatchObject({ from: B, value: { hello: true } });
    expect(letters[0]?.id.startsWith(`${B}:`)).toBe(true);
    expect(
      f.fake.calls
        .filter((c) => c.request.method === "PUT" && c.url.includes("/kv/mail"))
        .at(-1)?.request.headers["if-none-match"],
    ).toBeUndefined();
  });
  it("7: request/accept is mutual, block hides requests, list joins presence", async () => {
    const f = fixture();
    const a = f.kit(A),
      b = f.kit(B);
    await a.signIn();
    await b.signIn();
    await a.kit.friends.profile.set({ displayName: "Alice" });
    await b.kit.friends.profile.set({ displayName: "Bob" });
    const requested: string[] = [];
    b.kit.friends.on("requested", (from) => requested.push(from));
    await drain();
    await a.kit.friends.request(B);
    f.scheduler.advance(30000);
    await drain();
    expect(requested).toEqual([A]);
    await b.kit.friends.accept(A);
    f.fake.online.add(B);
    expect(await a.kit.friends.list()).toEqual([
      {
        userId: B,
        profile: { displayName: "Bob", avatar: null },
        online: true,
      },
    ]);
    expect((await b.kit.friends.list())[0]?.userId).toBe(A);
    await b.kit.friends.block(A);
    await expect(a.kit.friends.request(B)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect((await b.kit.friends.requests()).incoming).toEqual([]);
    await b.kit.friends.unblock(A);
    await a.kit.friends.request(B);
    await b.kit.friends.decline(A);
    expect((await b.kit.friends.requests()).incoming).toEqual([]);
    await a.kit.friends.remove(B);
    expect(await a.kit.friends.list()).toEqual([]);
  });
  it("8: callback-less live matching forms a four-member room", async () => {
    const f = fixture();
    const live = [A, B, C, D].map((id) =>
      f.kit(id, {
        config: {
          auth: { url: "https://auth.invalid", channelId: "ch" },
          state: { url: "https://state.invalid" },
          gateway: { url: "wss://gateway.invalid", lobbyChannelId: "lobby" },
          match: { url: "wss://match.invalid", channelId: "match" },
        },
      }),
    );
    for (const p of live) {
      await p.signIn();
      p.kit.room.on("invited", () => {});
    }
    await drain();
    const matches = live.map((p) => p.kit.matchmaking.find());
    f.fake.match([A, B, C, D]);
    await Promise.all(matches);
    expect(live.map((p) => p.kit.room.id)).toEqual(
      Array(4).fill(live[0]!.kit.room.id),
    );
    expect(live[0]?.kit.room.members).toHaveLength(4);
  });
  it("8: callback result null does not form a room when callback is explicit", async () => {
    const f = fixture();
    const a = f.kit(A, {
      config: {
        auth: { url: "https://auth.invalid", channelId: "ch" },
        gateway: { url: "wss://gateway.invalid", lobbyChannelId: "lobby" },
        match: { url: "wss://match.invalid", channelId: "match" },
      },
      matchmaking: { callback: true },
    });
    await a.signIn();
    a.kit.room.on("invited", () => {});
    await drain();
    const match = a.kit.matchmaking.find();
    f.fake.match([A], { result: null });
    expect((await match).result).toBeNull();
    expect(a.kit.room.id).toBeUndefined();
  });
  it("8: a missing matched member yields partial after the room window", async () => {
    const f = fixture();
    const a = f.kit(A, {
      config: {
        auth: { url: "https://auth.invalid", channelId: "ch" },
        gateway: { url: "wss://gateway.invalid", lobbyChannelId: "lobby" },
        match: { url: "wss://match.invalid", channelId: "match" },
      },
    });
    await a.signIn();
    a.kit.room.on("invited", () => {});
    await drain();
    const match = a.kit.matchmaking.find();
    f.fake.match([A, B]);
    await drain();
    f.scheduler.advance(30000);
    expect(await match).toMatchObject({
      partial: true,
      members: [{ userId: A }],
    });
  });
  it("9: proposal accepts confirm all members; decline cooldown retries once", async () => {
    const f = fixture();
    const a = f.kit(A),
      b = f.kit(B);
    await a.signIn();
    await b.signIn();
    const states: string[] = [];
    a.kit.matchmaking.on("stateChanged", (t) => states.push(t.state));
    await a.kit.matchmaking.submit();
    await b.kit.matchmaking.submit();
    expect((await a.kit.matchmaking.status())?.state).toBe("proposed");
    await a.kit.matchmaking.accept();
    await b.kit.matchmaking.accept();
    const status = a.kit.matchmaking.status();
    f.scheduler.advance(1000);
    expect(await status).toMatchObject({
      state: "confirmed",
      members: [{ userId: A }, { userId: B }],
    });
    expect(states).toContain("confirmed");
    await a.kit.matchmaking.cancel();
    await b.kit.matchmaking.cancel();
    await a.kit.matchmaking.submit();
    await b.kit.matchmaking.submit();
    await b.kit.matchmaking.decline();
    const submitted = b.kit.matchmaking.submit();
    await drain();
    f.scheduler.advance(5000);
    await drain();
    expect((await submitted).state).toBe("proposed");
  });
  it("10: token/topic registration, channel-checked push wake and sign-out cleanup", async () => {
    const f = fixture();
    const topics = {
      subscribe: vi.fn(() => Promise.resolve()),
      unsubscribe: vi.fn(() => Promise.resolve()),
    };
    const a = f.kit(A, { push: { topics } });
    await a.signIn();
    await a.kit.push.register({
      token: "fcm-token",
      project: "firebase-project",
    });
    expect(topics.subscribe).toHaveBeenCalledWith("configured.topic");
    await a.kit.matchmaking.submit();
    expect(
      a.kit.push.classify({
        data: { channelId: "wrong", matchId: "m", state: "proposed" },
      }).kind,
    ).toBe("message");
    f.fake.setTicket(A, {
      state: "proposed",
      matchId: "m",
      acceptBy: 1700000040,
      accepted: false,
      partial: false,
    });
    expect(
      a.kit.push.classify({
        data: { channelId: "match", matchId: "m", state: "proposed" },
      }).kind,
    ).toBe("match");
    await drain();
    expect(
      f.fake.calls.some(
        (c) => c.url.includes("/m/match/ticket") && c.request.method === "GET",
      ),
    ).toBe(true);
    await a.kit.session.signOut();
    expect(f.fake.pushes.size).toBe(0);
    expect(topics.unsubscribe).toHaveBeenCalledWith("configured.topic");
    expect(a.kit.session.userId).toBeUndefined();
  });
});
describe("lifecycle, cache and failure regression", () => {
  it("checks optional config on use and leaves construction intact", async () => {
    const f = fixture();
    const a = f.kit(A, {
      config: { auth: { url: "https://auth.invalid", channelId: "ch" } },
    });
    await a.signIn();
    await expect(a.kit.board("missing")).rejects.toMatchObject({
      code: "not_configured",
    });
    await expect(a.kit.mail.list()).rejects.toMatchObject({
      code: "not_configured",
    });
    await expect(a.kit.friends.requests()).rejects.toMatchObject({
      code: "not_configured",
    });
    await expect(a.kit.matchmaking.submit()).rejects.toMatchObject({
      code: "not_configured",
    });
    expect(() => a.kit.push.classify({})).toThrow();
  });
  it("profile batches at 50 and caches for 30 seconds per session", async () => {
    const f = fixture();
    const a = f.kit(A);
    await a.signIn();
    const ids = Array.from({ length: 51 }, (_, i) =>
      i.toString(16).padStart(32, "0"),
    );
    for (const id of ids)
      f.fake.profiles.set(id, {
        owner: id,
        displayName: id,
        avatar: null,
        updatedAt: 1700000000,
      });
    expect(await a.kit.friends.profiles(ids)).toHaveLength(51);
    const calls = () =>
      f.fake.calls.filter((c) => c.url.includes("/social/profiles")).length;
    expect(calls()).toBe(2);
    expect(await a.kit.friends.profiles(ids)).toHaveLength(51);
    expect(calls()).toBe(2);
    f.scheduler.advance(30000);
    await a.kit.friends.profiles(ids);
    expect(calls()).toBe(4);
    await a.kit.session.fromToken(f.fake.register(B));
    await a.kit.friends.profiles(ids);
    expect(calls()).toBe(6);
    expect(await a.kit.friends.profile.me()).toBeUndefined();
  });
  it("friends presence batches at 50 and invite refuses offline", async () => {
    const f = fixture();
    const ids = Array.from({ length: 51 }, (_, i) =>
      i.toString(16).padStart(32, "0"),
    );
    const base = f.fake.fetch;
    const a = f.kit(A, {
      fetch: (url, request) =>
        url.endsWith("/social/friends")
          ? Promise.resolve(
              fakeResponse(200, {
                friends: ids.map((owner) => ({
                  owner,
                  displayName: "Player",
                  avatar: null,
                  since: 1,
                })),
              }),
            )
          : base(url, request),
    });
    await a.signIn();
    expect(await a.kit.friends.list()).toHaveLength(51);
    expect(
      f.fake.calls
        .filter((c) => c.url.includes("/presence?"))
        .map(
          (c) => new URL(c.url).searchParams.get("users")!.split(",").length,
        ),
    ).toEqual([50, 1]);
    await expect(a.kit.friends.invite(B)).rejects.toMatchObject({
      code: "offline",
    });
    f.fake.online.add(B);
    const invited = vi.spyOn(a.kit.room, "invite").mockResolvedValue();
    await a.kit.friends.invite(B);
    expect(invited).toHaveBeenCalledWith(B);
  });
  it("mail and requests stop in background and resume without duplicates", async () => {
    const f = fixture();
    const a = f.kit(A);
    await a.signIn();
    f.fake.state.seed("mail", "gift", 1, A);
    const arrived: string[] = [];
    a.kit.mail.on("arrived", (v) => arrived.push(v.id));
    const off = a.kit.friends.on("requested", () => {});
    await drain();
    const before = f.fake.calls.length;
    a.kit.setForeground(false);
    f.scheduler.advance(60000);
    await drain();
    expect(f.fake.calls.length).toBe(before);
    a.kit.setForeground(true);
    await drain();
    expect(arrived).toEqual(["gift"]);
    off();
  });
  it("failed pagination neither advances watermark nor emits incomplete arrivals", async () => {
    const f = fixture();
    let fail = true;
    let phase = 0;
    const base = f.fake.fetch;
    const a = f.kit(A, {
      fetch: (url, request) => {
        if (url.includes("/kv/mail/") && request.method === "GET") {
          phase++;
          if (new URL(url).searchParams.has("cursor"))
            return fail
              ? Promise.resolve(fakeResponse(503, {}))
              : Promise.resolve(fakeResponse(200, { entries: [] }));
          return Promise.resolve(
            fakeResponse(200, {
              entries: [
                {
                  key: "gift",
                  version: 1,
                  bytes: 1,
                  updatedAt: 1700000000,
                  from: "server",
                  valueText: "1",
                },
              ],
              nextCursor: "page2",
            }),
          );
        }
        return base(url, request);
      },
    });
    await a.signIn();
    const arrived: string[] = [];
    a.kit.mail.on("arrived", (v) => arrived.push(v.id));
    await drain();
    expect(arrived).toEqual([]);
    fail = false;
    f.scheduler.advance(30000);
    await drain();
    expect(phase).toBeGreaterThan(2);
    expect(arrived).toEqual(["gift"]);
  });
  it("maps mailbox caps and rejects server-only sends", async () => {
    const f = fixture();
    const a = f.kit(A);
    await a.signIn();
    const c = f.fake.state.collection("mail", "user", "server");
    await expect(a.kit.mail.send({ to: B, value: 1 })).rejects.toMatchObject({
      code: "server_only",
    });
    c.writeScope = "project";
    for (let i = 0; i < 1000; i++) f.fake.state.seed("mail", String(i), 1, B);
    await expect(a.kit.mail.send({ to: B, value: 1 })).rejects.toMatchObject({
      code: "inbox_full",
      retryable: true,
    });
    await expect(a.kit.mail.claim("missing")).rejects.toMatchObject({
      code: "already_claimed",
    });
  });
  it("deferred polling coalesces push hints and respects background/resume", async () => {
    const f = fixture();
    const a = f.kit(A, {
      push: {
        topics: {
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
        },
      },
    });
    await a.signIn();
    await a.kit.matchmaking.submit();
    const hint = () =>
      a.kit.push.classify({
        data: { channelId: "match", matchId: "m", state: "proposed" },
      });
    hint();
    hint();
    await drain();
    const reads = () =>
      f.fake.calls.filter(
        (c) => c.url.includes("/m/") && c.request.method === "GET",
      ).length;
    expect(reads()).toBe(1);
    hint();
    await drain();
    a.kit.setForeground(false);
    f.scheduler.advance(10000);
    await drain();
    expect(reads()).toBe(1);
    hint();
    await drain();
    expect(reads()).toBe(1);
    a.kit.setForeground(true);
    await drain();
    expect(reads()).toBe(2);
    await a.kit.matchmaking.cancel();
    f.scheduler.advance(30000);
    await drain();
    expect(reads()).toBe(2);
  });
  it("confirming retries and cancellation settle reserved retry waits", async () => {
    const f = fixture();
    const a = f.kit(A);
    await a.signIn();
    f.fake.setTicket(A, {
      state: "proposed",
      matchId: "m",
      acceptBy: 1700000040,
      accepted: false,
      partial: false,
    });
    f.fake.setRefusal({ status: 409, reason: "confirming" });
    const accept = a.kit.matchmaking.accept();
    await drain();
    f.fake.setRefusal();
    f.scheduler.advance(1500);
    await drain();
    expect((await accept).state).toBe("confirmed");
    f.fake.setRefusal({ status: 429 });
    const submit = a.kit.matchmaking.submit();
    const checked = expect(submit).rejects.toMatchObject({ code: "cancelled" });
    await drain();
    f.fake.setRefusal();
    await a.kit.matchmaking.cancel();
    await checked;
    f.scheduler.advance(60000);
    await drain();
  });
  it("state conflict reads status rather than resubmitting", async () => {
    const f = fixture();
    const base = f.fake.fetch;
    let submits = 0;
    const a = f.kit(A, {
      fetch: (url, request) => {
        if (url.includes("/m/") && request.method === "POST") {
          submits++;
          return Promise.resolve(
            fakeResponse(409, {
              error: { code: "conflict", details: { reason: "proposed" } },
            }),
          );
        }
        return base(url, request);
      },
    });
    await a.signIn();
    f.fake.setTicket(A, {
      state: "proposed",
      matchId: "m",
      acceptBy: 1700000040,
      accepted: false,
      partial: false,
    });
    expect((await a.kit.matchmaking.submit()).state).toBe("proposed");
    expect(submits).toBe(1);
  });
  it("live mode requires lobby, rejects deferred-only methods and times out", async () => {
    const f = fixture();
    const a = f.kit(A, {
      config: {
        auth: { url: "https://auth.invalid", channelId: "ch" },
        gateway: { url: "wss://gateway.invalid", lobbyChannelId: "lobby" },
        match: { url: "wss://match.invalid", channelId: "match" },
      },
    });
    await a.signIn();
    await expect(a.kit.matchmaking.find()).rejects.toMatchObject({
      code: "lobby_required",
    });
    await expect(a.kit.matchmaking.submit()).rejects.toMatchObject({
      code: "invalid_state",
    });
    a.kit.room.on("invited", () => {});
    await drain();
    const match = a.kit.matchmaking.find({ timeoutMs: 1000 });
    const rejected = expect(match).rejects.toMatchObject({ code: "cancelled" });
    f.scheduler.advance(1000);
    await rejected;
    await a.kit.matchmaking.cancel();
  });
  it("session generation protects in-flight profiles from cache pollution", async () => {
    const f = fixture();
    let release: () => void = () => {};
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = f.fake.fetch;
    const a = f.kit(A, {
      fetch: async (url, request) => {
        if (url.includes("/social/profiles")) await wait;
        return base(url, request);
      },
    });
    await a.signIn();
    const profiles = a.kit.friends.profiles([B]);
    const checked = expect(profiles).rejects.toMatchObject({
      code: "signed_out",
    });
    await drain();
    await a.kit.session.fromToken(f.fake.register(C));
    release();
    await checked;
  });
  it("late registration cleans the old identity and cannot block local sign-out", async () => {
    const f = fixture();
    let release: () => void = () => {};
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = f.fake.fetch;
    const topics = {
      subscribe: vi.fn(() => Promise.resolve()),
      unsubscribe: vi.fn(() => Promise.reject(new Error("PRIVATE"))),
    };
    const a = f.kit(A, {
      push: { topics },
      fetch: async (url, request) => {
        if (url.includes("/push/") && request.method === "PUT") await wait;
        return base(url, request);
      },
    });
    await a.signIn();
    const registration = a.kit.push.register({ token: "old-token" });
    const checked = expect(registration).rejects.toMatchObject({
      code: "signed_out",
    });
    await drain();
    const signedOut = a.kit.session.signOut();
    expect(a.kit.session.userId).toBeUndefined();
    release();
    await checked;
    await signedOut;
    expect(f.fake.pushes.size).toBe(0);
    expect(topics.subscribe).not.toHaveBeenCalled();
    const deletes = f.fake.calls.filter(
      (c) => c.url.includes("/push/") && c.request.method === "DELETE",
    );
    expect(deletes.length).toBeGreaterThan(0);
    expect(deletes[0]?.request.headers.Authorization).toBe(`Bearer ${a.token}`);
  });
  it("push changes token serially and explicitly unregisters topic", async () => {
    const f = fixture();
    const topics = {
      subscribe: vi.fn(() => Promise.resolve()),
      unsubscribe: vi.fn(() => Promise.resolve()),
    };
    const a = f.kit(A, { push: { topics } });
    await a.signIn();
    await Promise.all([
      a.kit.push.register({ token: "first" }),
      a.kit.push.register({ token: "second" }),
    ]);
    expect([...f.fake.pushes.keys()]).toEqual(["second"]);
    await a.kit.push.unregister();
    expect(f.fake.pushes.size).toBe(0);
    expect(topics.unsubscribe).toHaveBeenCalled();
  });
});
describe("adversarial review regressions", () => {
  it("around never issues a new-user request after a session switch", async () => {
    const f = fixture();
    let gate = false,
      release: () => void = () => {};
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = f.fake.fetch;
    const a = f.kit(A, {
      fetch: async (url, request) => {
        if (gate && url.includes("/scores/me")) await wait;
        return base(url, request);
      },
    });
    await a.signIn();
    const board = await a.kit.board("weekly");
    await board.submit({ score: 20 });
    gate = true;
    const pending = board.around({ period: "weekly", span: 1 });
    const checked = expect(pending).rejects.toMatchObject({
      code: "signed_out",
    });
    await drain();
    await a.kit.session.fromToken(f.fake.register(B));
    release();
    await checked;
    expect(f.fake.calls.filter((c) => c.url.includes("/top?"))).toEqual([]);
  });
  it("observer-triggered user switch stops remaining old mailbox events and listeners", async () => {
    const f = fixture();
    const a = f.kit(A);
    await a.signIn();
    f.fake.state.seed("mail", "first", { private: "A" }, A);
    f.fake.state.seed("mail", "second", { private: "A" }, A);
    let change: Promise<unknown> | undefined;
    const received: string[] = [];
    const other = vi.fn();
    a.kit.mail.on("arrived", (v) => {
      received.push(v.id);
      change = a.kit.session.fromToken(f.fake.register(B));
    });
    a.kit.mail.on("arrived", other);
    await drain();
    await change;
    expect(received).toHaveLength(1);
    expect(other).not.toHaveBeenCalled();
    expect(a.kit.session.userId).toBe(B);
  });
  it("sanitizes hostile push input reflection without credential echo", async () => {
    const f = fixture();
    const a = f.kit(A, {
      push: {
        topics: {
          subscribe: () => Promise.resolve(),
          unsubscribe: () => Promise.resolve(),
        },
      },
    });
    await a.signIn();
    const input = new Proxy(
      { token: "SECRET-TOKEN" },
      {
        ownKeys() {
          throw new TypeError("PRIVATE-CREDENTIAL");
        },
      },
    );
    const error: unknown = await a.kit.push
      .register(input)
      .catch((e) => e as unknown);
    expect(error).toMatchObject({ name: "KitError", code: "push_refused" });
    expect(String(error)).not.toContain("PRIVATE-CREDENTIAL");
    expect(f.fake.calls.filter((c) => c.url.includes("/push/"))).toEqual([]);
  });
  it("cold-session resume discovers a ticket and continues polling", async () => {
    const f = fixture();
    const a = f.kit(A);
    await a.signIn();
    f.fake.setTicket(A, { state: "waiting", position: 2, waited: 3 });
    const states: string[] = [];
    a.kit.matchmaking.on("stateChanged", (t) => states.push(t.state));
    a.kit.setForeground(false);
    a.kit.setForeground(true);
    await drain();
    expect(states).toEqual(["waiting"]);
    const reads = () =>
      f.fake.calls.filter(
        (c) => c.url.includes("/m/") && c.request.method === "GET",
      ).length;
    expect(reads()).toBe(1);
    f.scheduler.advance(4000);
    await drain();
    expect(reads()).toBe(2);
  });
  it("public status and a proposed-conflict recovery both keep polling", async () => {
    for (const conflict of [false, true]) {
      const f = fixture();
      const base = f.fake.fetch;
      const a = f.kit(A, {
        fetch: (url, request) =>
          conflict && url.includes("/m/") && request.method === "POST"
            ? Promise.resolve(
                fakeResponse(409, {
                  error: { code: "conflict", details: { reason: "proposed" } },
                }),
              )
            : base(url, request),
      });
      await a.signIn();
      f.fake.setTicket(A, {
        state: "proposed",
        matchId: "m",
        acceptBy: 1700000040,
        accepted: false,
        partial: false,
      });
      await (conflict
        ? a.kit.matchmaking.submit()
        : a.kit.matchmaking.status());
      const reads = () =>
        f.fake.calls.filter(
          (c) => c.url.includes("/m/") && c.request.method === "GET",
        ).length;
      expect(reads()).toBe(1);
      f.scheduler.advance(4000);
      await drain();
      expect(reads()).toBe(2);
    }
  });
  it("an empty matchId expiry hint discovers status without a local ticket", async () => {
    const f = fixture();
    const a = f.kit(A);
    await a.signIn();
    f.fake.setTicket(A, { state: "expired", reason: "wait" });
    const states: string[] = [];
    a.kit.matchmaking.on("stateChanged", (t) => states.push(t.state));
    expect(
      a.kit.push.classify({
        data: { channelId: "match", matchId: "", state: "expired" },
      }),
    ).toMatchObject({ kind: "match", matchId: "" });
    await drain();
    expect(states).toEqual(["expired"]);
  });
});
it("accepts an invitation arriving before the invitee's matched frame", async () => {
  const f = fixture();
  const config = {
    auth: { url: "https://auth.invalid", channelId: "ch" },
    gateway: { url: "wss://gateway.invalid", lobbyChannelId: "lobby" },
    match: { url: "wss://match.invalid", channelId: "match" },
  };
  const a = f.kit(A, { config }),
    b = f.kit(B, { config });
  await a.signIn();
  await b.signIn();
  a.kit.room.on("invited", () => {});
  b.kit.room.on("invited", () => {});
  await drain();
  const completed = Promise.all([
    a.kit.matchmaking.find(),
    b.kit.matchmaking.find(),
  ]);
  void completed.catch(() => {});
  const members = [{ userId: A }, { userId: B }];
  f.fake.match([A], { matchId: "one-match", members });
  await drain();
  expect(f.fake.gateway.sent.some((s) => s.frame.type === "party.invite")).toBe(
    true,
  );
  f.fake.match([B], { matchId: "one-match", members });
  await drain();
  expect(b.kit.room.members).toHaveLength(2);
  expect(a.kit.room.id).toBe(b.kit.room.id);
  const results = await completed;
  expect(results).toHaveLength(2);
  expect(results.every((r) => !r.partial)).toBe(true);
});
