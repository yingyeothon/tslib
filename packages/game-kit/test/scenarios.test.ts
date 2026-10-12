import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGameKit,
  isKitError,
  type GameKit,
  type GameKitOptions,
  type QueuedWrite,
  type RoomInvitation,
} from "../src/index.js";
import {
  createFakeState,
  createFakeScheduler,
  createFakeGameGateway,
  fakeToken,
} from "../../../test-support/game-kit-fakes.js";
const kits: GameKit[] = [];
afterEach(() => {
  for (const kit of kits.splice(0)) kit.dispose();
  vi.unstubAllGlobals();
});
function fixture() {
  const scheduler = createFakeScheduler();
  const state = createFakeState({ now: () => 1700000000000 + scheduler.now() });
  const gateway = createFakeGameGateway();
  state.collection("save", "user", "user");
  state.collection("content", "project", "server");
  function kit(userId: string, options: Partial<GameKitOptions> = {}) {
    const token = state.register(userId);
    gateway.register(userId, token);
    const k = createGameKit({
      config: {
        auth: { url: "https://auth.invalid", channelId: "ch_test" },
        state: { url: "https://state.invalid" },
        gateway: { url: "wss://fake.invalid", lobbyChannelId: "ch_lobby" },
        collections: { save: "save", content: "content" },
      },
      fetch: state.fetch,
      WebSocket: gateway.WebSocket,
      scheduler,
      ...options,
    });
    kits.push(k);
    return { kit: k, token };
  }
  return { scheduler, state, gateway, kit };
}
async function party(f: ReturnType<typeof fixture>) {
  const a = f.kit("alice");
  const b = f.kit("bob");
  await a.kit.session.fromToken(a.token);
  await b.kit.session.fromToken(b.token);
  let invite: RoomInvitation | undefined;
  b.kit.room.on("invited", (v) => {
    invite = v;
  });
  await a.kit.room.create();
  await a.kit.room.invite("bob");
  await vi.waitFor(() => expect(invite).toBeDefined());
  await invite!.accept();
  await vi.waitFor(() => expect(a.kit.room.members).toHaveLength(2));
  return { a: a.kit, b: b.kit };
}
describe("Wave A scenarios", () => {
  it("1: clock ignores wall time, warns once and 401 stops modules", async () => {
    const f = fixture();
    const { kit, token } = f.kit("alice");
    let expiring = 0;
    let signedOut = 0;
    kit.session.on("expiring", () => {
      expiring++;
    });
    kit.session.on("signedOut", () => {
      signedOut++;
    });
    const short = f.state.register("alice", 1700000610);
    f.gateway.register("alice", short);
    await kit.session.fromToken(short);
    expect(kit.session.now()).toBe(1700000000000);
    const spy = vi.spyOn(Date, "now").mockReturnValue(1700000000000 + 86400000);
    try {
      f.scheduler.advance(10000);
      expect(kit.session.now()).toBe(1700000010000);
      expect(expiring).toBe(1);
      f.scheduler.advance(5000);
      expect(expiring).toBe(1);
    } finally {
      spy.mockRestore();
    }
    kit.content.subscribe("tuning", () => {});
    await kit.room.create();
    f.state.setRefusal(401);
    await expect(kit.save.load("settings")).rejects.toMatchObject({
      code: "signed_out",
    });
    expect(signedOut).toBe(1);
    expect(kit.session.token).toBeUndefined();
    expect(kit.room.id).toBeUndefined();
    expect(f.scheduler.pendingCount).toBe(0);
    f.state.setRefusal();
    await kit.session.fromToken(token);
    expect(kit.session.userId).toBe("alice");
  });
  it("2: version conflict/merge, TTL claim and bounded counter", async () => {
    const f = fixture();
    const a = f.kit("alice");
    const b = f.kit("alice");
    await a.kit.session.fromToken(a.token);
    await b.kit.session.fromToken(b.token);
    await a.kit.save.load("settings");
    await b.kit.save.load("settings");
    await a.kit.save.store("settings", { a: 1 });
    await expect(b.kit.save.store("settings", { b: 2 })).rejects.toMatchObject({
      code: "conflict",
    });
    await b.kit.save.store(
      "settings",
      { b: 2 },
      {
        merge: (local, remote) => ({
          ...(remote as object),
          ...(local as object),
        }),
      },
    );
    expect(await a.kit.save.load("settings")).toEqual({ a: 1, b: 2 });
    expect(await a.kit.save.claimOnce("reward", 10)).toBe(true);
    expect(await b.kit.save.claimOnce("reward", 10)).toBe(false);
    f.scheduler.advance(10001);
    expect(await b.kit.save.claimOnce("reward", 10)).toBe(true);
    expect(await a.kit.save.counter("wallet").add(3, { min: 0, max: 4 })).toBe(
      3,
    );
    await expect(
      a.kit.save.counter("wallet").add(-4, { min: 0 }),
    ).rejects.toMatchObject({ code: "out_of_range" });
    expect(await a.kit.save.load("wallet")).toBe(3);
    await a.kit.save.update<number>("wallet", (n) => n! + 1);
    expect(await b.kit.save.load("wallet")).toBe(4);
    await a.kit.save.remove("wallet");
    expect(await b.kit.save.load("wallet")).toBeUndefined();
  });
  it("3: invite, state resync, host succession and size refusal", async () => {
    const f = fixture();
    const { a, b } = await party(f);
    const states: unknown[] = [];
    let inherited: unknown;
    b.room.on("state", (v) => {
      states.push(v);
    });
    b.room.becomeHost((v) => {
      inherited = v.lastKnown;
    });
    await a.room.state.publish({ hp: 7 });
    await vi.waitFor(() => expect(states).toContainEqual({ hp: 7 }));
    await expect(a.room.send("big", "x".repeat(8193))).rejects.toMatchObject({
      code: "payload_too_large",
    });
    expect(() => a.room.send("kit.fake", {})).toThrow(RangeError);
    await expect(b.room.state.publish({ hp: 0 })).rejects.toMatchObject({
      code: "invalid_state",
    });
    f.gateway.disconnect("bob");
    await vi.waitFor(() => expect(states.length).toBeGreaterThan(1), {
      timeout: 3000,
    });
    await a.room.leave();
    await vi.waitFor(() => expect(b.room.isHost).toBe(true));
    expect(inherited).toEqual({ hp: 7 });
    await expect(b.room.invite("offline")).rejects.toMatchObject({
      code: "offline",
    });
  });
  it("4: turn replay, tamper detection and reconnect catch-up", async () => {
    const f = fixture();
    const { a, b } = await party(f);
    const start = {
      players: ["alice", "bob"],
      initial: 0,
      apply: (state: number, move: number) => state + move,
    };
    const ag = a.turns.start({ ...start, room: a.room });
    const bg = b.turns.start({ ...start, room: b.room });
    await vi.waitFor(async () => {
      await ag.submit(2);
    });
    await vi.waitFor(() => expect(bg.index).toBe(1));
    await bg.submit(3);
    await vi.waitFor(() => expect(ag.state).toBe(5));
    expect(bg.state).toBe(5);
    f.gateway.disconnect("bob");
    await ag.submit(4);
    await vi.waitFor(() => expect(bg.index).toBe(3), { timeout: 3000 });
    expect(bg.state).toBe(9);
    const replay = bg.log.reduce(
      (state, record) => start.apply(state, record.move),
      0,
    );
    expect(replay).toBe(ag.state);
    f.gateway.setFilter((_from, to, frame) => {
      if (to === "alice" && frame.name === "kit.turn") {
        const copy = JSON.parse(JSON.stringify(frame)) as {
          payload: { data: { hash: string } };
        };
        copy.payload.data.hash = "0".repeat(64);
        return copy;
      }
      return frame;
    });
    await bg.submit(1);
    await vi.waitFor(() => expect(ag.frozen).toBe(true));
  });
  it("restores a durable queue in order and pauses a conflict without policy", async () => {
    const f = fixture();
    const db = new Map<string, QueuedWrite[]>();
    const adapter = {
      load: (key: string) => Promise.resolve(db.get(key) ?? []),
      store: (key: string, items: QueuedWrite[]) => {
        db.set(key, structuredClone(items));
        return Promise.resolve();
      },
    };
    const old = f.kit("alice", { save: { offlineQueue: adapter } });
    await old.kit.session.fromToken(old.token);
    await old.kit.save.load("settings");
    f.state.setOnline(false);
    await old.kit.save.store("settings", { a: 1 });
    await old.kit.save.store("settings", { a: 2 });
    expect(old.kit.save.pendingCount).toBe(2);
    expect(await old.kit.save.load("settings")).toEqual({ a: 2 });
    old.kit.dispose();
    const restored = f.kit("alice", { save: { offlineQueue: adapter } });
    await restored.kit.session.fromToken(restored.token);
    f.state.setOnline(true);
    await restored.kit.save.flush();
    expect(restored.kit.save.pendingCount).toBe(0);
    expect(await restored.kit.save.load("settings")).toEqual({ a: 2 });
    f.state.setOnline(false);
    await restored.kit.save.store("settings", { a: 3 });
    f.state.setOnline(true);
    f.state.seed("save", "settings", { remote: 4 }, "alice");
    await expect(restored.kit.save.flush()).rejects.toMatchObject({
      code: "conflict",
    });
    expect(restored.kit.save.pendingCount).toBe(1);
    restored.kit.dispose();
    const merged = f.kit("alice", {
      save: {
        offlineQueue: adapter,
        mergePolicies: {
          settings: (local, remote) => ({
            ...(remote as object),
            ...(local as object),
          }),
        },
      },
    });
    await merged.kit.session.fromToken(merged.token);
    await merged.kit.save.flush();
    expect(await merged.kit.save.load("settings")).toEqual({ remote: 4, a: 3 });
    const other = f.kit("bob", { save: { offlineQueue: adapter } });
    await other.kit.session.fromToken(other.token);
    await other.kit.save.flush();
    expect(await other.kit.save.load("settings")).toBeUndefined();
  });
  it("content caches, compares versions and pauses polling", async () => {
    const f = fixture();
    const { kit, token } = f.kit("alice");
    f.state.seed("content", "tuning", { speed: 1 });
    await kit.session.fromToken(token);
    const changes: unknown[] = [];
    const off = kit.content.subscribe("tuning", (v) => {
      changes.push(v);
    });
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    expect(await kit.content.get("tuning")).toEqual({ speed: 1 });
    expect(await kit.content.list({ prefix: "tun" })).toEqual([
      { key: "tuning", value: { speed: 1 } },
    ]);
    f.scheduler.advance(60000);
    await vi.waitFor(() =>
      expect(
        f.state.requests.filter((r) => r.path.endsWith("tuning")).length,
      ).toBeGreaterThan(2),
    );
    expect(changes).toHaveLength(1);
    kit.setForeground(false);
    const count = f.state.requests.length;
    f.scheduler.advance(60000);
    await Promise.resolve();
    expect(f.state.requests).toHaveLength(count);
    f.state.seed("content", "tuning", { speed: 2 });
    kit.setForeground(true);
    await vi.waitFor(() => expect(changes).toHaveLength(2));
    off();
    kit.dispose();
    expect(f.scheduler.pendingCount).toBe(0);
  });
  it("maps local configuration and network errors without secrets", async () => {
    const kit = createGameKit({
      config: {},
      fetch: () => Promise.reject(new Error("SECRET")),
    });
    kits.push(kit);
    await expect(kit.save.load("a")).rejects.toMatchObject({
      code: "not_configured",
    });
    expect(() => kit.content.subscribe("a", () => {})).toThrow();
    await expect(kit.room.create()).rejects.toMatchObject({
      code: "not_configured",
    });
    await expect(kit.session.signIn()).rejects.toMatchObject({
      code: "not_configured",
    });
    await kit.session.fromToken(fakeToken("alice"));
    expect(() => kit.session.now()).toThrow();
    expect(isKitError(null)).toBe(false);
    expect(() =>
      kit.turns.start({
        room: kit.room,
        initial: 0,
        players: [],
        apply: (state) => state,
      }),
    ).toThrow(TypeError);
  });
  it("restores token storage and accepts a host login adapter", async () => {
    const f = fixture();
    const token = f.state.register("alice");
    let stored: string | undefined = token;
    const storage = {
      load: () => Promise.resolve(stored),
      store: (v: string) => {
        stored = v;
        return Promise.resolve();
      },
      clear: () => {
        stored = undefined;
        return Promise.resolve();
      },
    };
    const cancel = vi.fn();
    const { kit } = f.kit("alice", {
      tokenStorage: storage,
      login: {
        redirectUrl: "https://game.invalid/callback",
        adapter: {
          open: (startUrl) => {
            const redirect = new URL(
              new URL(startUrl).searchParams.get("redirect")!,
            );
            redirect.hash = new URLSearchParams({
              token,
              userId: "alice",
              exp: "2000000000",
            }).toString();
            return { returnedUrl: Promise.resolve(redirect.href), cancel };
          },
        },
      },
    });
    expect((await kit.session.restore())?.userId).toBe("alice");
    expect((await kit.session.signIn()).userId).toBe("alice");
    expect(cancel).toHaveBeenCalled();
    await kit.session.signOut();
    expect(stored).toBeUndefined();
    expect(await kit.session.restore()).toBeUndefined();
  });
});

describe("recovery and extension seams", () => {
  it("uses the default popup, removes its fragment and cleans polling", async () => {
    const f = fixture();
    const token = f.state.register("alice");
    let start = "";
    let returned = "https://provider.invalid/oauth";
    const close = vi.fn();
    const replaceState = vi.fn();
    const popup = {
      closed: false,
      location: {
        get href() {
          return returned;
        },
      },
      history: { replaceState },
      close,
    };
    vi.stubGlobal("open", (url: string) => {
      start = url;
      return popup;
    });
    const { kit } = f.kit("alice", {
      login: { redirectUrl: "https://game.invalid/callback" },
    });
    const signed = kit.session.signIn();
    f.scheduler.advance(200);
    const redirect = new URL(new URL(start).searchParams.get("redirect")!);
    redirect.hash = new URLSearchParams({
      token,
      userId: "alice",
      exp: "2000000000",
    }).toString();
    returned = redirect.href;
    f.scheduler.advance(200);
    expect((await signed).userId).toBe("alice");
    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      expect.not.stringContaining("#"),
    );
    expect(close).toHaveBeenCalled();
    await kit.session.signOut();
    expect(f.scheduler.pendingCount).toBe(0);
  });
  it("handles popup cancellation, timeout and blocking", async () => {
    const f = fixture();
    const popup = {
      closed: false,
      location: { href: "https://provider.invalid" },
      history: { replaceState() {} },
      close() {
        popup.closed = true;
      },
    };
    vi.stubGlobal("open", () => popup);
    const { kit } = f.kit("alice", {
      login: { redirectUrl: "https://game.invalid/callback", timeoutMs: 1000 },
    });
    const rejected = expect(kit.session.signIn()).rejects.toMatchObject({
      code: "unavailable",
    });
    f.scheduler.advance(1000);
    await rejected;
    expect(popup.closed).toBe(true);
    expect(f.scheduler.pendingCount).toBe(0);
    popup.closed = true;
    const cancelled = expect(kit.session.signIn()).rejects.toMatchObject({
      code: "cancelled",
    });
    f.scheduler.advance(200);
    await cancelled;
    vi.stubGlobal("open", () => null);
    await expect(kit.session.signIn()).rejects.toMatchObject({
      code: "unavailable",
    });
  });
  it("retries clock synchronization after an offline restore and expires once", async () => {
    const f = fixture();
    const { kit } = f.kit("alice");
    const token = f.state.register("alice", 1700000010);
    f.state.setOnline(false);
    await kit.session.fromToken(token);
    expect(() => kit.session.now()).toThrow();
    f.state.setOnline(true);
    kit.setForeground(false);
    kit.setForeground(true);
    await vi.waitFor(() => expect(kit.session.now()).toBe(1700000000000));
    let count = 0;
    kit.session.on("signedOut", () => {
      count++;
    });
    f.scheduler.advance(10000);
    expect(count).toBe(1);
    expect(kit.session.token).toBeUndefined();
    await expect(
      kit.session.fromToken(fakeToken("alice", 1699999999)),
    ).rejects.toMatchObject({ code: "signed_out" });
  });
  it("ignores stale HTTP responses after a different user signs in", async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    const fetch: NonNullable<GameKitOptions["fetch"]> = async (
      url,
      request,
    ) => {
      const response = await f.state.fetch(url, request);
      if (url.endsWith("/settings") && request.method === "GET")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return response;
    };
    const { kit, token } = f.kit("alice", { fetch });
    f.state.seed("save", "settings", "alice-secret", "alice");
    await kit.session.fromToken(token);
    const response = expect(kit.save.load("settings")).rejects.toMatchObject({
      code: "signed_out",
    });
    await vi.waitFor(() => expect(release).toBeDefined());
    const bob = f.state.register("bob");
    await kit.session.fromToken(bob);
    release!();
    await response;
    release = undefined;
    const latest = kit.save.load("settings");
    await vi.waitFor(() => expect(release).toBeDefined());
    release!();
    expect(await latest).toBeUndefined();
  });
  it("sends user events, filters reserved controls and handles observers throwing", async () => {
    const f = fixture();
    const { a, b } = await party(f);
    const messages: unknown[] = [];
    const off = b.room.on("greet", (v) => {
      messages.push(v);
    });
    a.room.on("memberOnline", () => {
      throw new Error("observer-secret");
    });
    await a.room.whisper("bob", "greet", { text: "hello" });
    await vi.waitFor(() =>
      expect(messages).toEqual([{ from: "alice", payload: { text: "hello" } }]),
    );
    off();
    await a.room.send("greet", 1);
    await Promise.resolve();
    expect(messages).toHaveLength(1);
    await expect(a.room.whisper("nobody", "greet", {})).rejects.toMatchObject({
      code: "offline",
    });
    let decline: RoomInvitation | undefined;
    b.room.on("invited", (v) => {
      decline = v;
    });
    await b.room.leave();
    await a.room.invite("bob");
    await vi.waitFor(() => expect(decline).toBeDefined());
    await decline!.decline();
  });
  it("splits persisted logs, restores complete revisions, and saves each result", async () => {
    const f = fixture();
    const { a, b } = await party(f);
    type Move = { padding: string; add: number };
    const options = {
      initial: 0,
      players: ["alice", "bob"],
      persist: true,
      saveResultAs: "result",
      apply: (state: number, move: Move) => state + move.add,
    };
    const ag = a.turns.start({ ...options, room: a.room });
    const bg = b.turns.start({ ...options, room: b.room });
    for (let i = 0; i < 10; i++) {
      await (i % 2 ? bg : ag).submit({ padding: "x".repeat(2500), add: 1 });
      await vi.waitFor(() => expect((i % 2 ? ag : bg).index).toBe(i + 1));
    }
    expect(ag.state).toBe(10);
    expect(bg.state).toBe(10);
    const manifest = await a.save.load<{ chunks: number; count: number }>(
      `turns:${a.room.id}`,
    );
    expect(manifest?.chunks).toBeGreaterThan(1);
    expect(manifest?.count).toBe(10);
    ag.dispose();
    const restored = a.turns.start({ ...options, room: a.room });
    await vi.waitFor(() => expect(restored.index).toBe(10));
    expect(restored.state).toBe(10);
    await restored.finish({ winner: "alice" });
    await vi.waitFor(async () =>
      expect(await b.save.load("result")).toMatchObject({
        result: { winner: "alice" },
      }),
    );
    expect(await a.save.load("result")).toMatchObject({
      result: { winner: "alice" },
    });
  });
  it("does not restore partial log revisions or continue a mismatch", async () => {
    const f = fixture();
    const { kit, token } = f.kit("alice");
    await kit.session.fromToken(token);
    await kit.room.create();
    const game = kit.turns.start({
      room: kit.room,
      players: ["alice"],
      initial: 0,
      apply: (s: number, move: number) => s + move,
      persist: true,
    });
    await game.submit(1);
    const key = `turns:${kit.room.id}`;
    const manifest = await kit.save.load<{
      revision: string;
      gameId: string;
      chunks: number;
    }>(key);
    game.dispose();
    await kit.save.remove(`${key}:${manifest!.gameId}:${manifest!.revision}:0`);
    const broken = kit.turns.start({
      room: kit.room,
      players: ["alice"],
      initial: 0,
      apply: (s: number, move: number) => s + move,
      persist: true,
    });
    await expect(broken.submit(1)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(broken.index).toBe(0);
  });
  it("refuses invalid moves, wrong turns and JSON without changing state", async () => {
    const f = fixture();
    const { a, b } = await party(f);
    const apply = (s: number, m: number) => {
      if (m < 0) throw new Error("invalid move");
      return s + m;
    };
    const ag = a.turns.start({
      room: a.room,
      players: ["alice", "bob"],
      initial: 0,
      apply,
    });
    const bg = b.turns.start({
      room: b.room,
      players: ["alice", "bob"],
      initial: 0,
      apply,
    });
    await expect(ag.submit(-1)).rejects.toMatchObject({
      code: "invalid_state",
    });
    expect(ag.index).toBe(0);
    await ag.submit(1);
    await vi.waitFor(() => expect(bg.index).toBe(1));
    await expect(ag.submit(1)).rejects.toMatchObject({ code: "not_your_turn" });
    await expect(bg.finish("result")).rejects.toMatchObject({
      code: "invalid_state",
    });
    for (const value of [
      NaN,
      undefined,
      {
        toJSON() {
          return 1;
        },
      },
      "\ud800",
      new Date(),
      [undefined],
    ])
      await expect(a.room.send("json", value)).rejects.toThrow(TypeError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(a.room.send("json", cyclic)).rejects.toThrow(TypeError);
    const getter = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        return "secret";
      },
    });
    await expect(a.room.send("json", getter)).rejects.toThrow(TypeError);
  });
});

describe("adversarial regressions", () => {
  it("keeps an in-flight save bound to its original user across microtasks", async () => {
    const f = fixture();
    const { kit, token } = f.kit("alice");
    const bob = f.state.register("bob");
    await kit.session.fromToken(token);
    const outcome = kit.save
      .store("private", { secret: "alice-private" })
      .catch((error) => error as unknown);
    queueMicrotask(() =>
      queueMicrotask(() => {
        void kit.session.fromToken(bob);
      }),
    );
    const result = await outcome;
    expect(result).toMatchObject({ code: "signed_out" });
    expect(await kit.save.load("private")).toBeUndefined();
  });
  it("invalidates a pending restore and serializes token-store cleanup", async () => {
    const f = fixture();
    let releaseLoad: ((value: string) => void) | undefined;
    let releaseStore: (() => void) | undefined;
    let stored: string | undefined;
    const { kit, token } = f.kit("alice", {
      tokenStorage: {
        load: () =>
          new Promise((resolve) => {
            releaseLoad = resolve;
          }),
        store: (token) =>
          new Promise((resolve) => {
            releaseStore = () => {
              stored = token;
              resolve();
            };
          }),
        clear: () => {
          stored = undefined;
          return Promise.resolve();
        },
      },
    });
    const restored = expect(kit.session.restore()).rejects.toMatchObject({
      code: "signed_out",
    });
    await kit.session.signOut();
    releaseLoad!(token);
    await restored;
    const adoption = expect(kit.session.fromToken(token)).rejects.toMatchObject(
      { code: "signed_out" },
    );
    await vi.waitFor(() => expect(releaseStore).toBeDefined());
    const signOut = kit.session.signOut();
    releaseStore!();
    await adoption;
    await signOut;
    expect(stored).toBeUndefined();
  });
  it("recovers queued writes after server commit but adapter acknowledgement failure", async () => {
    const f = fixture();
    const db = new Map<string, QueuedWrite[]>();
    let failRemoval = false;
    const { kit, token } = f.kit("alice", {
      save: {
        offlineQueue: {
          load: (key) => Promise.resolve(db.get(key) ?? []),
          store: (key, rows) => {
            if (failRemoval && rows.length === 0) {
              failRemoval = false;
              return Promise.reject(new Error("adapter unavailable"));
            }
            db.set(key, structuredClone(rows));
            return Promise.resolve();
          },
        },
      },
    });
    await kit.session.fromToken(token);
    await kit.save.load("value");
    f.state.setOnline(false);
    await kit.save.store("value", 7);
    f.state.setOnline(true);
    failRemoval = true;
    await expect(kit.save.flush()).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(kit.save.pendingCount).toBe(1);
    await kit.save.flush();
    expect(kit.save.pendingCount).toBe(0);
    expect(await kit.save.load("value")).toBe(7);
  });
  it("delivers both concurrent states and accepts a new host senderSession", async () => {
    const f = fixture();
    const { a, b } = await party(f);
    const received: unknown[] = [];
    b.room.on("state", (v) => {
      received.push(v);
    });
    await Promise.all([a.room.state.publish(1), a.room.state.publish(2)]);
    await vi.waitFor(() => expect(received).toEqual([1, 2]));
    const token = a.session.token!;
    a.dispose();
    const replacement = f.kit("alice");
    await replacement.kit.session.fromToken(token);
    replacement.kit.room.on("state", () => {});
    await vi.waitFor(() => expect(replacement.kit.room.isHost).toBe(true));
    await replacement.kit.room.state.publish(3);
    await vi.waitFor(() => expect(received).toContain(3));
  });
  it("does not freeze valid turns on persistence failure, and retries result sinks", async () => {
    const f = fixture();
    const { kit, token } = f.kit("alice");
    await kit.session.fromToken(token);
    await kit.room.create();
    const game = kit.turns.start({
      room: kit.room,
      initial: 0,
      players: ["alice"],
      apply: (state: number, move: number) => state + move,
      persist: true,
      saveResultAs: "result",
    });
    const errors: unknown[] = [];
    game.on("error", (e) => {
      errors.push(e);
    });
    await game.submit(1);
    f.state.setRefusal(503);
    await game.submit(2);
    expect(game.state).toBe(3);
    expect(game.frozen).toBe(false);
    expect(errors).toContainEqual(
      expect.objectContaining({ code: "unavailable" }),
    );
    await expect(game.finish({ score: 3 })).rejects.toMatchObject({
      code: "unavailable",
    });
    f.state.setRefusal();
    await game.finish({ score: 3 });
    expect(await kit.save.load("result")).toMatchObject({
      result: { score: 3 },
    });
  });
  it("assembles out-of-order chunks and applies buffered live turns afterward", async () => {
    const f = fixture();
    const { a, b } = await party(f);
    const options = {
      initial: 0,
      saveResultAs: "assembly-result",
      players: ["alice", "bob"],
      apply: (s: number, m: number) => s + m,
    };
    const ag = a.turns.start({ ...options, room: a.room });
    const bg = b.turns.start({ ...options, room: b.room });
    await ag.submit(1);
    await vi.waitFor(() => expect(bg.index).toBe(1));
    await bg.submit(2);
    await vi.waitFor(() => expect(ag.index).toBe(2));
    const original = ag.log;
    bg.dispose();
    f.gateway.setFilter((_from, to, frame) =>
      to === "bob" &&
      ["kit.turns.manifest", "kit.turns.chunk"].includes(String(frame.name))
        ? undefined
        : frame,
    );
    const newGame = b.turns.start({ ...options, room: b.room });
    await vi.waitFor(() =>
      expect(
        f.gateway.sent.filter(
          (x) => x.from === "bob" && x.frame.name === "kit.turns.log",
        ).length,
      ).toBe(2),
    );
    await ag.submit(3);
    await ag.finish("done");
    expect(await b.save.load("assembly-result")).toBeUndefined();
    const request = f.gateway.sent
      .filter((x) => x.from === "bob" && x.frame.name === "kit.turns.log")
      .at(-1)!.frame.payload as { data: { requestId: string } };
    const turn = f.gateway.sent
      .filter((x) => x.frame.name === "kit.turn")
      .at(-1)!.frame.payload as { data: { gameId: string } };
    let seq = 0;
    const inject = (name: string, data: unknown) =>
      f.gateway.inject("bob", {
        type: "event",
        from: "alice",
        name,
        scope: "user",
        payload: {
          v: 1,
          roomId: b.room.id,
          senderSession: "injected-log",
          seq: ++seq,
          data,
        },
      });
    const metadata = {
      gameId: turn.data.gameId,
      requestId: request.data.requestId,
    };
    inject("kit.turns.manifest", {
      ...metadata,
      count: 2,
      finalHash: original[1]!.hash,
      chunks: 2,
    });
    inject("kit.turns.chunk", { ...metadata, part: 1, records: [original[1]] });
    inject("kit.turns.chunk", { ...metadata, part: 1, records: [original[1]] });
    inject("kit.turns.chunk", { ...metadata, part: 0, records: [original[0]] });
    await vi.waitFor(() => expect(newGame.index).toBe(3));
    expect(newGame.state).toBe(6);
    expect(newGame.frozen).toBe(false);
    await vi.waitFor(async () =>
      expect(await b.save.load("assembly-result")).toMatchObject({
        result: "done",
        finalHash: ag.log[2]!.hash,
      }),
    );
  });
});

it("recovers DELETE acknowledgement and merged PUT response loss", async () => {
  const f = fixture();
  let loseMergedReply = false;
  let failRemoval = false;
  const db = new Map<string, QueuedWrite[]>();
  const fetch: NonNullable<GameKitOptions["fetch"]> = async (url, request) => {
    const response = await f.state.fetch(url, request);
    if (loseMergedReply && request.method === "PUT" && request.body === "5") {
      loseMergedReply = false;
      throw new Error("reply lost");
    }
    return response;
  };
  const { kit, token } = f.kit("alice", {
    fetch,
    save: {
      mergePolicies: {
        number: (local, remote) => Number(local) + Number(remote),
      },
      offlineQueue: {
        load: (key) => Promise.resolve(db.get(key) ?? []),
        store: (key, rows) => {
          if (failRemoval && !rows.length) {
            failRemoval = false;
            return Promise.reject(new Error("ack lost"));
          }
          db.set(key, structuredClone(rows));
          return Promise.resolve();
        },
      },
    },
  });
  await kit.session.fromToken(token);
  f.state.seed("save", "number", 1, "alice");
  await kit.save.load("number");
  f.state.seed("save", "number", 2, "alice");
  loseMergedReply = true;
  await kit.save.store("number", 3);
  expect(kit.save.pendingCount).toBe(1);
  await kit.save.flush();
  expect(await kit.save.load("number")).toBe(5);
  f.state.setOnline(false);
  await kit.save.remove("number");
  f.state.setOnline(true);
  failRemoval = true;
  await expect(kit.save.flush()).rejects.toMatchObject({ code: "unavailable" });
  await kit.save.flush();
  expect(await kit.save.load("number")).toBeUndefined();
  expect(kit.save.pendingCount).toBe(0);
});
it("pins the published JCS hash vector and refuses array accessors", async () => {
  const f = fixture();
  const { kit, token } = f.kit("alice");
  await kit.session.fromToken(token);
  await kit.room.create();
  const game = kit.turns.start({
    room: kit.room,
    initial: 0,
    players: ["alice"],
    apply: (state: number, _move: { x: number; y: number }) => state + 1,
  });
  await game.submit({ y: 2, x: 1 });
  expect(game.log[0]?.hash).toBe(
    "8e48ac7f284692548995d918cbc6328694734bef04eb5dad33144fcd7d300c2a",
  );
  let reads = 0;
  const array = [1];
  Object.defineProperty(array, "0", {
    enumerable: true,
    get() {
      return ++reads;
    },
  });
  await expect(kit.room.send("array", array)).rejects.toThrow(TypeError);
  expect(reads).toBe(0);
});
it.each([2, 4, 6, 8, 10, 12])(
  "never reuses the previous user's cache after switch at microtask %i",
  async (delay) => {
    const f = fixture();
    const { kit, token } = f.kit("alice", {
      save: {
        offlineQueue: {
          load: () => Promise.resolve([]),
          store: () => Promise.resolve(),
        },
      },
    });
    const bob = f.state.register("bob");
    f.state.seed("save", "private", "alice-secret", "alice");
    f.state.seed("save", "private", "bob-value", "bob");
    await kit.session.fromToken(token);
    const old = kit.save.load("private").catch(() => undefined);
    let adopted: Promise<unknown> | undefined;
    function step(n: number) {
      queueMicrotask(() => {
        if (n) step(n - 1);
        else adopted = kit.session.fromToken(bob);
      });
    }
    step(delay);
    await old;
    await vi.waitFor(() => expect(adopted).toBeDefined());
    await adopted;
    expect(await kit.save.load("private")).toBe("bob-value");
    f.state.setOnline(false);
    expect(await kit.save.load("private")).toBe("bob-value");
  },
);

it("restores a finished game from an online peer while its host is offline", async () => {
  const f = fixture();
  const { a, b } = await party(f);
  const c = f.kit("charlie");
  await c.kit.session.fromToken(c.token);
  let invitation: RoomInvitation | undefined;
  c.kit.room.on("invited", (v) => {
    invitation = v;
  });
  await a.room.invite("charlie");
  await vi.waitFor(() => expect(invitation).toBeDefined());
  await invitation!.accept();
  const options = {
    initial: 0,
    players: ["alice", "bob"],
    saveResultAs: "result",
    apply: (s: number, move: number) => s + move,
  };
  const ag = a.turns.start({ ...options, room: a.room });
  const bg = b.turns.start({ ...options, room: b.room });
  const cg = c.kit.turns.start({ ...options, room: c.kit.room });
  await ag.submit(1);
  await vi.waitFor(() => expect(cg.index).toBe(1));
  f.gateway.disconnect("charlie");
  await bg.submit(2);
  await vi.waitFor(() => expect(ag.index).toBe(2));
  await ag.finish("done");
  f.gateway.disconnect("alice", 4000);
  await vi.waitFor(
    async () =>
      expect(await c.kit.save.load("result")).toMatchObject({
        result: "done",
        finalHash: ag.log[1]!.hash,
      }),
    { timeout: 3000 },
  );
  expect(cg.state).toBe(3);
});

it("uses only explicitly registered merge policies for prototype-named keys", async () => {
  const f = fixture();
  const { kit, token } = f.kit("alice", { save: { mergePolicies: {} } });
  await kit.session.fromToken(token);
  await kit.save.load("constructor");
  f.state.seed("save", "constructor", "remote", "alice");
  await expect(kit.save.store("constructor", "local")).rejects.toMatchObject({
    code: "conflict",
  });
  expect(await kit.save.load("constructor")).toBe("remote");
});
