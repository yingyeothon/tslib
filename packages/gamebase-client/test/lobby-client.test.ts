import type { LogWriter } from "@yingyeothon/logger";
import { createFilteredLogger } from "@yingyeothon/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GatewayLobbyClientOptions,
  Hello,
  StoppedEvent,
} from "../src/index.js";
import { createGatewayLobbyClient } from "../src/index.js";
import { createFakeWebSocketFactory, flush } from "./fake-web-socket.js";

const token = "eyJ.secret-token.sig";

const hello: Hello = {
  type: "hello",
  userId: "alice",
  connectionId: "gw1:abc",
  tick: 200,
  mapUrl: "https://cdn/map/v1.json",
  zone: "town",
  capabilities: {
    pos: true,
    say: ["zone", "party", "user"],
    party: true,
    event: true,
  },
};

function capturingWriter() {
  const lines: string[] = [];
  const writer: LogWriter = {
    debug: (...args) => lines.push(JSON.stringify(args)),
    info: (...args) => lines.push(JSON.stringify(args)),
    warn: (...args) => lines.push(JSON.stringify(args)),
    error: (...args) => lines.push(JSON.stringify(args)),
  };
  return { lines, logger: createFilteredLogger({ severity: "debug", writer }) };
}

function setup(overrides: Partial<GatewayLobbyClientOptions> = {}) {
  const factory = createFakeWebSocketFactory();
  const { lines, logger } = capturingWriter();
  const client = createGatewayLobbyClient({
    url: "wss://gw.test",
    channelId: "ch_lobby",
    token,
    WebSocket: factory.WebSocket,
    backoff: { initialMs: 500, jitter: 0, random: () => 0 },
    logger,
    ...overrides,
  });
  return { client, factory, lines };
}

async function connected(overrides: Partial<GatewayLobbyClientOptions> = {}) {
  const ctx = setup(overrides);
  const pending = ctx.client.connect();
  ctx.factory.latest().serverOpen();
  ctx.factory.latest().serverSend(hello);
  await pending;
  return ctx;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createGatewayLobbyClient: handshake", () => {
  it("opens the gateway URL with the bearer subprotocol pair", async () => {
    const { client, factory } = setup();
    const pending = client.connect();
    const socket = factory.latest();
    expect(socket.url).toBe("wss://gw.test/?channel=ch_lobby");
    expect(socket.protocols).toEqual(["bearer", token]);
    socket.serverOpen();
    socket.serverSend(hello);
    await expect(pending).resolves.toEqual(hello);
  });

  it("is not connected on open, only on hello", async () => {
    const { client, factory } = setup();
    const connectedHandler = vi.fn();
    client.on("connected", connectedHandler);
    const pending = client.connect();
    factory.latest().serverOpen();
    expect(client.state).toBe("connecting");
    expect(client.hello).toBeUndefined();
    expect(connectedHandler).not.toHaveBeenCalled();
    expect(() => client.ping()).toThrow("cannot send in state connecting");
    factory.latest().serverSend(hello);
    await pending;
    expect(client.state).toBe("connected");
    expect(client.capabilities).toEqual(hello.capabilities);
    expect(connectedHandler).toHaveBeenCalledWith(hello);
  });

  it("treats a non-hello first frame as a protocol error and keeps waiting", async () => {
    const { client, factory } = setup();
    const protocolError = vi.fn();
    client.on("protocolError", protocolError);
    const pending = client.connect();
    factory.latest().serverOpen();
    factory.latest().serverSend({ type: "pong" });
    expect(protocolError).toHaveBeenCalledWith({
      message: "expected hello, got pong",
    });
    factory.latest().serverSend(hello);
    await pending;
  });

  it("reconnects when hello does not arrive in time", async () => {
    const { client, factory } = setup({ helloTimeoutMs: 1000 });
    const reconnecting = vi.fn();
    client.on("reconnecting", reconnecting);
    const pending = client.connect();
    factory.latest().serverOpen();
    await vi.advanceTimersByTimeAsync(1000);
    expect(factory.latest().clientClose?.reason).toBe("hello timeout");
    expect(reconnecting).toHaveBeenCalledWith({ attempt: 1, delayMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    expect(factory.sockets).toHaveLength(2);
    factory.latest().serverOpen();
    factory.latest().serverSend(hello);
    await expect(pending).resolves.toEqual(hello);
  });

  it("stops when the gateway does not echo the bearer subprotocol", async () => {
    const { client, factory } = setup();
    const stopped = vi.fn();
    client.on("stopped", stopped);
    const pending = client.connect();
    factory.latest().serverOpen("");
    await expect(pending).rejects.toThrow("bearer subprotocol");
    expect(stopped).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "stop", code: 4900 }),
    );
    expect(factory.sockets).toHaveLength(1);
  });

  it("rejects connect() when the socket cannot be constructed", async () => {
    const { client } = setup({
      WebSocket: class {
        constructor() {
          throw new Error("bad url");
        }
      } as never,
    });
    await expect(client.connect()).rejects.toThrow(
      "cannot open WebSocket: bad url",
    );
    await expect(client.connect()).rejects.toThrow(
      "connect() called in state closed",
    );
  });

  it("never writes the token to the log", async () => {
    const { lines } = await connected();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("lobby connected");
    expect(lines.join("\n")).not.toContain(token);
  });
});

describe("createGatewayLobbyClient: senders and capabilities", () => {
  it("sends typed lobby frames", async () => {
    const { client, factory } = await connected();
    client.pos({ zone: "town", x: 1, y: 2 });
    client.say({ scope: "user", to: "bob", text: "psst" });
    client.event({
      scope: "party",
      name: "dungeon.offer",
      payload: { level: 3 },
    });
    client.party.create();
    client.party.invite("bob");
    client.party.accept("pty_1");
    client.party.decline("pty_2");
    client.party.list();
    client.party.leave();
    client.ping();
    expect(factory.latest().sent).toEqual([
      { type: "pos", zone: "town", x: 1, y: 2 },
      { type: "say", scope: "user", to: "bob", text: "psst" },
      {
        type: "event",
        scope: "party",
        name: "dungeon.offer",
        payload: { level: 3 },
      },
      { type: "party.create" },
      { type: "party.invite", userId: "bob" },
      { type: "party.accept", partyId: "pty_1" },
      { type: "party.decline", partyId: "pty_2" },
      { type: "party.list" },
      { type: "party.leave" },
      { type: "ping" },
    ]);
  });

  it("refuses locally what the channel's capabilities disable", async () => {
    const { client, factory } = setup();
    const pending = client.connect();
    factory.latest().serverOpen();
    factory.latest().serverSend({
      ...hello,
      capabilities: { pos: false, say: ["zone"], party: false, event: false },
    });
    await pending;
    expect(() => client.pos({ zone: "town", x: 0, y: 0 })).toThrow(
      "capability_off",
    );
    expect(() => client.say({ scope: "party", text: "x" })).toThrow(
      "capability_off",
    );
    expect(() =>
      client.event({ scope: "zone", name: "n", payload: 1 }),
    ).toThrow("capability_off");
    expect(() => client.party.create()).toThrow("capability_off");
    client.say({ scope: "zone", text: "ok" });
    expect(factory.latest().sent).toEqual([
      { type: "say", scope: "zone", text: "ok" },
    ]);
  });

  it("allows everything when the capability object is empty", async () => {
    const { client, factory } = setup();
    const pending = client.connect();
    factory.latest().serverOpen();
    factory.latest().serverSend({ ...hello, capabilities: {} });
    await pending;
    client.pos({ zone: "town", x: 0, y: 0 });
    client.say({ scope: "user", to: "bob", text: "hi" });
    expect(factory.latest().sent).toHaveLength(2);
  });
});

describe("createGatewayLobbyClient: peers and frames", () => {
  it("builds the peer map from snapshot/enter/leave/pos and filters self", async () => {
    const { client, factory } = await connected();
    const events: unknown[] = [];
    client.on("snapshot", (frame) => events.push(["snapshot", frame.zone]));
    client.on("peerEnter", (peer) => events.push(["enter", peer.userId]));
    client.on("peerMove", (peers) =>
      events.push(["move", peers.map((p) => p.userId)]),
    );
    client.on("peerLeave", (userId) => events.push(["leave", userId]));
    const socket = factory.latest();
    socket.serverSend({
      type: "snapshot",
      zone: "town",
      peers: [
        { userId: "alice", x: 0, y: 0 },
        { userId: "bob", x: 1, y: 1 },
      ],
    });
    socket.serverSend({
      type: "enter",
      zone: "town",
      userId: "carol",
      x: 2,
      y: 2,
      dir: 1,
    });
    socket.serverSend({
      type: "pos",
      zone: "town",
      peers: [
        { userId: "alice", x: 5, y: 5 },
        { userId: "bob", x: 3, y: 1 },
      ],
    });
    socket.serverSend({ type: "leave", zone: "town", userId: "bob" });
    socket.serverSend({
      type: "pos",
      zone: "town",
      peers: [{ userId: "bob", x: 9, y: 9 }],
    });
    expect(events).toEqual([
      ["snapshot", "town"],
      ["enter", "carol"],
      ["move", ["bob"]],
      ["leave", "bob"],
    ]);
    expect(client.peers.all()).toEqual([
      { userId: "carol", x: 2, y: 2, dir: 1 },
    ]);
    expect(client.peers.get("alice")).toBeUndefined();
  });

  it("routes say/event/party/pong/error frames to typed events", async () => {
    const { client, factory } = await connected();
    const seen: string[] = [];
    client.on("say", (f) => seen.push(`say:${f.from}`));
    client.on("event", (f) => seen.push(`event:${f.name}`));
    client.on("party", (f) => seen.push(`party:${f.partyId}`));
    client.on("partyInvite", (f) => seen.push(`invite:${f.partyId}`));
    client.on("partyDeclined", (f) => seen.push(`declined:${f.userId}`));
    client.on("pong", () => seen.push("pong"));
    client.on("error", (f) => seen.push(`error:${f.code}`));
    client.on("protocolError", (f) => seen.push(`protocol:${f.message}`));
    const raw = vi.fn();
    client.on("frame", raw);
    const socket = factory.latest();
    socket.serverSend({
      type: "say",
      from: "bob",
      scope: "user",
      to: "alice",
      text: "hi",
    });
    socket.serverSend({
      type: "event",
      from: "bob",
      scope: "zone",
      name: "wave",
      payload: null,
    });
    socket.serverSend({
      type: "party",
      partyId: "pty_1",
      leaderId: "bob",
      members: [{ userId: "bob", online: true }],
      invited: [],
      max: 4,
    });
    expect(client.partyId).toBe("pty_1");
    expect(client.roster?.leaderId).toBe("bob");
    socket.serverSend({
      type: "party.invite",
      partyId: "pty_2",
      from: "carol",
    });
    socket.serverSend({
      type: "party.declined",
      partyId: "pty_1",
      userId: "dave",
    });
    socket.serverSend({ type: "pong" });
    socket.serverSend({
      type: "error",
      code: "move_too_far",
      message: "too far",
    });
    socket.serverSend({ type: "mystery" });
    socket.serverSendRaw("not json");
    socket.serverSendRaw(new ArrayBuffer(2));
    socket.serverSend([1, 2]);
    socket.serverSend({
      type: "party",
      partyId: "",
      leaderId: "",
      members: [],
      invited: [],
      max: 4,
    });
    expect(client.partyId).toBeUndefined();
    expect(seen).toEqual([
      "say:bob",
      "event:wave",
      "party:pty_1",
      "invite:pty_2",
      "declined:dave",
      "pong",
      "error:move_too_far",
      "protocol:unknown frame type mystery",
      "protocol:frame is not JSON",
      "protocol:non-text frame",
      "protocol:frame has no string type",
      "party:",
    ]);
    expect(raw).toHaveBeenCalledTimes(9);
  });

  it("takes partyId from hello and normalises an empty one", async () => {
    const { client } = await connected();
    expect(client.partyId).toBeUndefined();
    const { client: withParty, factory } = setup();
    const pending = withParty.connect();
    factory.latest().serverOpen();
    factory.latest().serverSend({ ...hello, partyId: "pty_9" });
    await pending;
    expect(withParty.partyId).toBe("pty_9");
  });

  it("does not enter itself into the peer map", async () => {
    const { client, factory } = await connected();
    const peerEnter = vi.fn();
    client.on("peerEnter", peerEnter);
    factory.latest().serverSend({ type: "snapshot", zone: "town", peers: [] });
    factory.latest().serverSend({
      type: "enter",
      zone: "town",
      userId: "alice",
      x: 0,
      y: 0,
    });
    expect(peerEnter).not.toHaveBeenCalled();
    expect(client.peers.all()).toEqual([]);
  });

  it("emits to the handler set as it was when the emit started", async () => {
    const { client, factory } = await connected();
    const b = vi.fn();
    const c = vi.fn();
    let offB = () => undefined as void;
    client.on("pong", () => {
      offB();
      client.on("pong", c);
    });
    offB = client.on("pong", b);
    factory.latest().serverSend({ type: "pong" });
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).not.toHaveBeenCalled();
    factory.latest().serverSend({ type: "pong" });
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops delivery", async () => {
    const { client, factory } = await connected();
    const handler = vi.fn();
    const off = client.on("pong", handler);
    factory.latest().serverSend({ type: "pong" });
    off();
    factory.latest().serverSend({ type: "pong" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("fetches the map from hello.mapUrl once", async () => {
    const calls: string[] = [];
    const { client } = await connected({
      fetch: (url) => {
        calls.push(url);
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve("{}"),
        });
      },
    });
    await expect(client.map()).resolves.toEqual({});
    await expect(client.map()).resolves.toEqual({});
    expect(calls).toEqual([hello.mapUrl]);
  });

  it("map() rejects before hello", async () => {
    const { client } = setup();
    await expect(client.map()).rejects.toThrow("needs hello first");
  });
});

describe("createGatewayLobbyClient: reconnect policy", () => {
  it.each([4002, 1001, 1006])(
    "reconnects after %d with exponential backoff and a fresh peer map",
    async (code) => {
      const { client, factory } = await connected();
      const order: string[] = [];
      client.on("disconnected", (e) =>
        order.push(`disconnected:${e.code}:${e.willReconnect}`),
      );
      client.on("reconnecting", (e) =>
        order.push(`reconnecting:${e.attempt}:${e.delayMs}`),
      );
      client.on("connected", () => order.push("connected"));
      factory.latest().serverSend({
        type: "snapshot",
        zone: "town",
        peers: [{ userId: "bob", x: 1, y: 1 }],
      });
      factory.latest().serverClose(code, "bye");
      expect(client.state).toBe("reconnecting");
      expect(client.peers.all()).toEqual([]);
      await vi.advanceTimersByTimeAsync(499);
      expect(factory.sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(factory.sockets).toHaveLength(2);
      factory.latest().serverError();
      await vi.advanceTimersByTimeAsync(1000);
      expect(factory.sockets).toHaveLength(3);
      factory.latest().serverOpen();
      factory.latest().serverSend({ ...hello, partyId: "pty_after" });
      expect(client.state).toBe("connected");
      expect(client.partyId).toBe("pty_after");
      expect(order).toEqual([
        `disconnected:${code}:true`,
        "reconnecting:1:500",
        "disconnected:1006:true",
        "reconnecting:2:1000",
        "connected",
      ]);
      factory.latest().serverClose(4002);
      await vi.advanceTimersByTimeAsync(500);
      expect(factory.sockets).toHaveLength(4);
    },
  );

  it.each([4000, 4003, 4004, 1000, 1003, 1009])(
    "stops after %d without opening another socket",
    async (code) => {
      const { client, factory } = await connected();
      const stopped = vi.fn<(event: StoppedEvent) => void>();
      const disconnected = vi.fn();
      client.on("stopped", stopped);
      client.on("disconnected", disconnected);
      factory.latest().serverClose(code);
      await vi.advanceTimersByTimeAsync(60000);
      expect(factory.sockets).toHaveLength(1);
      expect(client.state).toBe("closed");
      expect(disconnected).toHaveBeenCalledWith(
        expect.objectContaining({ code, willReconnect: false }),
      );
      expect(stopped).toHaveBeenCalledWith(expect.objectContaining({ code }));
      expect(stopped.mock.calls[0]?.[0]?.kind).not.toBe("reconnect");
    },
  );

  it("stops after repeated closes before open, but not after real sessions", async () => {
    const { client, factory } = setup({ maxHandshakeFailures: 3 });
    const stopped = vi.fn();
    client.on("stopped", stopped);
    const outcome = expect(client.connect()).rejects.toThrow(
      "handshake failed",
    );
    factory.latest().serverError();
    await vi.advanceTimersByTimeAsync(500);
    factory.latest().serverError();
    await vi.advanceTimersByTimeAsync(1000);
    expect(factory.sockets).toHaveLength(3);
    expect(stopped).not.toHaveBeenCalled();
    factory.latest().serverError();
    await vi.advanceTimersByTimeAsync(60000);
    expect(factory.sockets).toHaveLength(3);
    expect(stopped).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "handshake failed 3 times in a row" }),
    );
    await outcome;

    // Positive control: a successful open resets the counter.
    const { client: healthy, factory: f2 } = setup({ maxHandshakeFailures: 2 });
    const stopped2 = vi.fn();
    healthy.on("stopped", stopped2);
    void healthy.connect().catch(() => undefined);
    for (let i = 0; i < 4; i += 1) {
      f2.latest().serverOpen();
      f2.latest().serverSend(hello);
      f2.latest().serverClose(4002);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(f2.sockets).toHaveLength(5);
    expect(stopped2).not.toHaveBeenCalled();
  });

  it("forgets the roster on a new hello without a party", async () => {
    const { client, factory } = await connected();
    factory.latest().serverSend({
      type: "party",
      partyId: "pty_1",
      leaderId: "alice",
      members: [{ userId: "alice", online: true }],
      invited: [],
      max: 4,
    });
    expect(client.roster?.partyId).toBe("pty_1");
    factory.latest().serverClose(4002);
    await vi.advanceTimersByTimeAsync(500);
    factory.latest().serverOpen();
    factory.latest().serverSend(hello);
    expect(client.partyId).toBeUndefined();
    expect(client.roster).toBeUndefined();
  });

  it("gives up after maxAttempts", async () => {
    const { client, factory } = await connected({
      backoff: { initialMs: 100, jitter: 0, maxAttempts: 2 },
    });
    const stopped = vi.fn();
    client.on("stopped", stopped);
    factory.latest().serverClose(4002);
    await vi.advanceTimersByTimeAsync(100);
    factory.latest().serverClose(4002);
    await vi.advanceTimersByTimeAsync(200);
    factory.latest().serverClose(4002);
    expect(factory.sockets).toHaveLength(3);
    expect(stopped).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "reconnect attempts exhausted" }),
    );
  });

  it("close() ends the session without reconnecting", async () => {
    const { client, factory } = await connected();
    const disconnected = vi.fn();
    const stopped = vi.fn();
    client.on("disconnected", disconnected);
    client.on("stopped", stopped);
    client.close();
    client.close();
    await flush();
    expect(factory.latest().clientClose).toEqual({
      code: 1000,
      reason: "client closed",
    });
    expect(client.state).toBe("closed");
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(stopped).not.toHaveBeenCalled();
    expect(() => client.ping()).toThrow("cannot send in state closed");
  });

  it("close() while a reconnect is pending cancels the timer itself", async () => {
    const { client, factory } = await connected();
    factory.latest().serverClose(4002);
    expect(vi.getTimerCount()).toBe(1);
    client.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(factory.sockets).toHaveLength(1);
  });

  it("close() before open closes the connecting socket and ignores a late open", async () => {
    const { client, factory } = setup();
    const connectedHandler = vi.fn();
    client.on("connected", connectedHandler);
    const outcome = expect(client.connect()).rejects.toThrow(
      "closed before the connection became ready",
    );
    client.close();
    await outcome;
    expect(factory.latest().clientClose).toEqual({
      code: 1000,
      reason: "client closed",
    });
    factory.latest().serverOpen();
    factory.latest().serverSend(hello);
    expect(connectedHandler).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the hello timer once hello arrives", async () => {
    const { client, factory } = await connected({ helloTimeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(factory.latest().clientClose).toBeUndefined();
    expect(client.state).toBe("connected");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores events from a socket it has already replaced", async () => {
    const { client, factory } = await connected();
    const stopped = vi.fn();
    const pong = vi.fn();
    client.on("stopped", stopped);
    client.on("pong", pong);
    const old = factory.latest();
    old.serverClose(4002);
    await vi.advanceTimersByTimeAsync(500);
    factory.latest().serverOpen();
    factory.latest().serverSend(hello);
    old.serverSend({ type: "pong" });
    old.serverClose(4000);
    expect(pong).not.toHaveBeenCalled();
    expect(stopped).not.toHaveBeenCalled();
    expect(client.state).toBe("connected");
  });

  it("refuses send() while reconnecting and after a server stop", async () => {
    const { client, factory } = await connected();
    factory.latest().serverClose(4002);
    expect(() => client.ping()).toThrow("cannot send in state reconnecting");
    await vi.advanceTimersByTimeAsync(500);
    factory.latest().serverOpen();
    factory.latest().serverSend(hello);
    factory.latest().serverClose(4000);
    expect(() => client.ping()).toThrow("cannot send in state closed");
  });

  it("close() before hello rejects the pending connect()", async () => {
    const { client, factory } = setup();
    const pending = client.connect();
    factory.latest().serverOpen();
    client.close();
    await expect(pending).rejects.toThrow(
      "closed before the connection became ready",
    );
  });
});
