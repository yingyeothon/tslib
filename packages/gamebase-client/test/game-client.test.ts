import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayGameClientOptions } from "../src/index.js";
import { createGatewayGameClient } from "../src/index.js";
import { createFakeWebSocketFactory } from "./fake-web-socket.js";

const token = "eyJ.game-token.sig";

function setup(overrides: Partial<GatewayGameClientOptions> = {}) {
  const factory = createFakeWebSocketFactory();
  const client = createGatewayGameClient({
    url: "wss://gw.test",
    channelId: "q_dungeon",
    gameId: "g_1",
    token,
    WebSocket: factory.WebSocket,
    backoff: { initialMs: 500, jitter: 0 },
    ...overrides,
  });
  return { client, factory };
}

async function connected() {
  const ctx = setup();
  const pending = ctx.client.connect();
  ctx.factory.latest().serverOpen();
  await pending;
  return ctx;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createGatewayGameClient", () => {
  it("connects with channel and gameId and is ready on open", async () => {
    const { client, factory } = setup();
    const connectedHandler = vi.fn();
    client.on("connected", connectedHandler);
    const pending = client.connect();
    const socket = factory.latest();
    expect(socket.url).toBe("wss://gw.test/?channel=q_dungeon&gameId=g_1");
    expect(socket.protocols).toEqual(["bearer", token]);
    expect(() => client.send({ type: "attack" })).toThrow(
      "cannot send in state connecting",
    );
    socket.serverOpen();
    await pending;
    expect(client.state).toBe("connected");
    expect(connectedHandler).toHaveBeenCalledTimes(1);
  });

  it("passes game frames through verbatim and separates gateway errors", async () => {
    const { client, factory } = await connected();
    const frames: unknown[] = [];
    const errors: unknown[] = [];
    client.on("frame", (f) => frames.push(f));
    client.on("error", (e) => errors.push(e));
    const socket = factory.latest();
    socket.serverSend({ type: "snapshot", payload: { bossHp: 100 } });
    socket.serverSend({
      type: "error",
      code: "rate_limited",
      message: "slow down",
    });
    socket.serverSend({ type: "error", payload: { custom: true } });
    expect(frames).toEqual([
      { type: "snapshot", payload: { bossHp: 100 } },
      { type: "error", payload: { custom: true } },
    ]);
    expect(errors).toEqual([
      { type: "error", code: "rate_limited", message: "slow down" },
    ]);
  });

  it("sends opaque frames and refuses the reserved types locally", async () => {
    const { client, factory } = await connected();
    client.send({ type: "attack", power: 3 });
    expect(() => client.send({ type: "enter", memberId: "x" })).toThrow(
      "reserved_type",
    );
    expect(() => client.send({ type: "leave" })).toThrow("reserved_type");
    expect(factory.latest().sent).toEqual([{ type: "attack", power: 3 }]);
  });

  it("emits aborted, not finished, on 4001 and never reconnects", async () => {
    const { client, factory } = await connected();
    const aborted = vi.fn();
    const finished = vi.fn();
    const stopped = vi.fn();
    client.on("aborted", aborted);
    client.on("finished", finished);
    client.on("stopped", stopped);
    factory.latest().serverClose(4001, "actor gone");
    await vi.advanceTimersByTimeAsync(60000);
    expect(aborted).toHaveBeenCalledWith({
      code: 4001,
      reason: "the game actor stopped responding",
    });
    expect(finished).not.toHaveBeenCalled();
    expect(stopped).not.toHaveBeenCalled();
    expect(factory.sockets).toHaveLength(1);
    expect(client.state).toBe("closed");
  });

  it("emits finished, not aborted, on 1000", async () => {
    const { client, factory } = await connected();
    const aborted = vi.fn();
    const finished = vi.fn();
    client.on("aborted", aborted);
    client.on("finished", finished);
    factory.latest().serverClose(1000);
    await vi.advanceTimersByTimeAsync(60000);
    expect(finished).toHaveBeenCalledWith(
      expect.objectContaining({ code: 1000 }),
    );
    expect(aborted).not.toHaveBeenCalled();
    expect(factory.sockets).toHaveLength(1);
  });

  it.each([1011, 4002, 1001])(
    "reconnects after %d and reports connected again",
    async (code) => {
      const { client, factory } = await connected();
      const connectedHandler = vi.fn();
      const reconnecting = vi.fn();
      client.on("connected", connectedHandler);
      client.on("reconnecting", reconnecting);
      factory.latest().serverClose(code);
      expect(reconnecting).toHaveBeenCalledWith({ attempt: 1, delayMs: 500 });
      await vi.advanceTimersByTimeAsync(500);
      expect(factory.sockets).toHaveLength(2);
      factory.latest().serverOpen();
      expect(connectedHandler).toHaveBeenCalledTimes(1);
      expect(client.state).toBe("connected");
      client.send({ type: "attack" });
      expect(factory.latest().sent).toEqual([{ type: "attack" }]);
    },
  );

  it.each([4000, 4003, 4004])("stops after %d", async (code) => {
    const { client, factory } = await connected();
    const stopped = vi.fn();
    client.on("stopped", stopped);
    factory.latest().serverClose(code);
    await vi.advanceTimersByTimeAsync(60000);
    expect(stopped).toHaveBeenCalledWith(expect.objectContaining({ code }));
    expect(factory.sockets).toHaveLength(1);
  });

  it("surfaces non-JSON frames as protocol errors", async () => {
    const { client, factory } = await connected();
    const protocolError = vi.fn();
    client.on("protocolError", protocolError);
    factory.latest().serverSendRaw("{");
    expect(protocolError).toHaveBeenCalledWith({
      message: "frame is not JSON",
    });
  });

  it("uses the global WebSocket when none is injected", () => {
    const original = (globalThis as { WebSocket?: unknown }).WebSocket;
    const factory = createFakeWebSocketFactory();
    (globalThis as { WebSocket?: unknown }).WebSocket = factory.WebSocket;
    try {
      const client = createGatewayGameClient({
        url: "wss://gw.test",
        channelId: "q",
        gameId: "g",
        token,
      });
      void client.connect().catch(() => undefined);
      expect(factory.sockets).toHaveLength(1);
      client.close();
    } finally {
      (globalThis as { WebSocket?: unknown }).WebSocket = original;
    }
  });

  it("fails clearly when no WebSocket is available", () => {
    const original = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket?: unknown }).WebSocket = undefined;
    try {
      expect(() =>
        createGatewayGameClient({
          url: "wss://gw.test",
          channelId: "q",
          gameId: "g",
          token,
        }),
      ).toThrow("No global WebSocket");
    } finally {
      (globalThis as { WebSocket?: unknown }).WebSocket = original;
    }
  });
});
