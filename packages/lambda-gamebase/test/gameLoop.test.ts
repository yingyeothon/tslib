import {
  createInMemoryLock,
  createInMemoryQueue,
  enqueue,
} from "@yingyeothon/actor-system";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import { capturingLogger } from "./capturingLogger.js";
import type { RedisConnection } from "@yingyeothon/naive-redis";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleActor,
  startActorLoop,
  type BaseGameRequest,
  type GameActorStartEvent,
} from "../src/index.js";

const logger: Logger = { ...nullLogger, severity: "none" };
const members = [
  { memberId: "m1", name: "one", email: "one@yyt.life" },
  { memberId: "m2", name: "two", email: "two@yyt.life" },
];
const fakeConnection = {} as RedisConnection;

function newSubsystem() {
  return { queue: createInMemoryQueue(), lock: createInMemoryLock(), logger };
}

describe("startActorLoop", () => {
  it("runs gameMain with polled messages and clears the start event", async () => {
    const subsystem = newSubsystem();
    await enqueue(
      { id: "game-1", queue: subsystem.queue, logger },
      { item: { type: "enter", connectionId: "c1", memberId: "m1" } },
    );

    const seen: BaseGameRequest[][] = [];
    const deleteStartEvent = vi.fn().mockResolvedValue(1);
    await startActorLoop<BaseGameRequest>({
      gameId: "game-1",
      members,
      eventKeyPrefix: "event:",
      logger,
      subsystem,
      redisConnection: fakeConnection,
      deleteStartEvent,
      gameMain: async ({ gameId, members: startMembers, pollMessages }) => {
        expect(gameId).toBe("game-1");
        expect(startMembers).toBe(members);
        seen.push(await pollMessages());
        seen.push(await pollMessages());
      },
    });

    expect(seen).toEqual([
      [{ type: "enter", connectionId: "c1", memberId: "m1" }],
      [],
    ]);
    expect(deleteStartEvent).toHaveBeenCalledWith("event:game-1");
  });

  it("clears the start event even when gameMain throws", async () => {
    const deleteStartEvent = vi.fn().mockResolvedValue(1);
    const errorLog = vi.fn();
    await startActorLoop({
      gameId: "game-1",
      members,
      eventKeyPrefix: "event:",
      logger: { ...logger, error: errorLog },
      subsystem: newSubsystem(),
      redisConnection: fakeConnection,
      deleteStartEvent,
      gameMain: () => Promise.reject(new Error("game crashed")),
    });

    expect(errorLog).toHaveBeenCalled();
    expect(deleteStartEvent).toHaveBeenCalledWith("event:game-1");
  });

  it("does not run gameMain when the actor lock is already held", async () => {
    const subsystem = newSubsystem();
    await subsystem.lock.tryAcquire("game-1");

    const gameMain = vi.fn();
    const deleteStartEvent = vi.fn();
    await startActorLoop({
      gameId: "game-1",
      members,
      eventKeyPrefix: "event:",
      logger,
      subsystem,
      redisConnection: fakeConnection,
      deleteStartEvent,
      gameMain,
    });

    expect(gameMain).not.toHaveBeenCalled();
    expect(deleteStartEvent).not.toHaveBeenCalled();
  });

  it("releases the lock after the loop so a new game can start", async () => {
    const subsystem = newSubsystem();
    const gameMain = vi.fn().mockResolvedValue(undefined);
    const options = {
      gameId: "game-1",
      members,
      eventKeyPrefix: "event:",
      logger,
      subsystem,
      redisConnection: fakeConnection,
      deleteStartEvent: () => Promise.resolve(1),
      gameMain,
    };
    await startActorLoop(options);
    await startActorLoop(options);
    expect(gameMain).toHaveBeenCalledTimes(2);
  });
});

describe("handleActor", () => {
  afterEach(() => vi.unstubAllGlobals());

  const startEvent: GameActorStartEvent = { gameId: "game-1", members };

  it("saves the start event, runs the game, and clears it at the end", async () => {
    const store = new Map<string, string>();
    const deleted: string[] = [];
    const gameMain = vi.fn().mockResolvedValue(undefined);

    await handleActor({
      event: startEvent,
      eventKeyPrefix: "event:",
      awaiterKeyPrefix: "awaiter:",
      queueKeyPrefix: "queue:",
      lockKeyPrefix: "lock:",
      lifetimeSeconds: 30,
      gameMain,
      logger,
      actorLogger: logger,
      redisConnection: fakeConnection,
      subsystem: newSubsystem(),
      saveStartEvent: (key, value) => {
        store.set(key, value);
        return Promise.resolve(true);
      },
      deleteStartEvent: (key) => {
        deleted.push(key);
        return Promise.resolve(1);
      },
    });

    expect(store.get("event:game-1")).toBe(JSON.stringify(startEvent));
    expect(deleted).toEqual(["event:game-1"]);
    expect(gameMain).toHaveBeenCalledOnce();
  });

  it("sends the ready signal to the lobby when callbackUrl is given", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleActor({
      event: { ...startEvent, callbackUrl: "https://lobby.yyt.life/ready" },
      eventKeyPrefix: "event:",
      awaiterKeyPrefix: "awaiter:",
      queueKeyPrefix: "queue:",
      lockKeyPrefix: "lock:",
      lifetimeSeconds: 30,
      gameMain: () => Promise.resolve(),
      logger,
      actorLogger: logger,
      redisConnection: fakeConnection,
      subsystem: newSubsystem(),
      saveStartEvent: () => Promise.resolve(true),
      deleteStartEvent: () => Promise.resolve(1),
    });

    expect(fetchMock).toHaveBeenCalledWith("https://lobby.yyt.life/ready", {
      method: "PUT",
    });
  });

  it("fails when the lobby rejects the ready signal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );

    await expect(
      handleActor({
        event: { ...startEvent, callbackUrl: "https://lobby.yyt.life/ready" },
        eventKeyPrefix: "event:",
        awaiterKeyPrefix: "awaiter:",
        queueKeyPrefix: "queue:",
        lockKeyPrefix: "lock:",
        lifetimeSeconds: 30,
        gameMain: () => Promise.resolve(),
        logger,
        actorLogger: logger,
        redisConnection: fakeConnection,
        subsystem: newSubsystem(),
        saveStartEvent: () => Promise.resolve(true),
        deleteStartEvent: () => Promise.resolve(1),
      }),
    ).rejects.toThrow("503");
  });

  it("ignores an event without gameId", async () => {
    const gameMain = vi.fn();
    const saveStartEvent = vi.fn();
    await handleActor({
      event: { gameId: "", members },
      eventKeyPrefix: "event:",
      awaiterKeyPrefix: "awaiter:",
      queueKeyPrefix: "queue:",
      lockKeyPrefix: "lock:",
      lifetimeSeconds: 30,
      gameMain,
      logger,
      actorLogger: logger,
      redisConnection: fakeConnection,
      subsystem: newSubsystem(),
      saveStartEvent,
      deleteStartEvent: () => Promise.resolve(1),
    });
    expect(gameMain).not.toHaveBeenCalled();
    expect(saveStartEvent).not.toHaveBeenCalled();
  });

  it("fails fast without a redisConnection or context", async () => {
    await expect(
      handleActor({
        event: startEvent,
        eventKeyPrefix: "event:",
        awaiterKeyPrefix: "awaiter:",
        queueKeyPrefix: "queue:",
        lockKeyPrefix: "lock:",
        lifetimeSeconds: 30,
        gameMain: () => Promise.resolve(),
      }),
    ).rejects.toThrow("requires either redisConnection or context");
  });

  it("signals ready only after this invocation owns the game", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const subsystem = newSubsystem();
    // A duplicate invocation: someone else already owns this game.
    await subsystem.lock.tryAcquire("game-1");

    const gameMain = vi.fn();
    await handleActor({
      event: { ...startEvent, callbackUrl: "https://lobby.yyt.life/ready" },
      eventKeyPrefix: "event:",
      awaiterKeyPrefix: "awaiter:",
      queueKeyPrefix: "queue:",
      lockKeyPrefix: "lock:",
      lifetimeSeconds: 30,
      gameMain,
      logger,
      actorLogger: logger,
      redisConnection: fakeConnection,
      subsystem,
      saveStartEvent: () => Promise.resolve(true),
      deleteStartEvent: () => Promise.resolve(1),
    });

    // Fired before the lock, this would tell the lobby a game is ready that
    // this invocation will never run.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gameMain).not.toHaveBeenCalled();
  });

  it("signals ready before the game loop starts", async () => {
    const order: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        order.push("ready");
        return Promise.resolve(new Response(null, { status: 200 }));
      }),
    );

    await handleActor({
      event: { ...startEvent, callbackUrl: "https://lobby.yyt.life/ready" },
      eventKeyPrefix: "event:",
      awaiterKeyPrefix: "awaiter:",
      queueKeyPrefix: "queue:",
      lockKeyPrefix: "lock:",
      lifetimeSeconds: 30,
      gameMain: () => {
        order.push("gameMain");
        return Promise.resolve();
      },
      logger,
      actorLogger: logger,
      redisConnection: fakeConnection,
      subsystem: newSubsystem(),
      saveStartEvent: () => Promise.resolve(true),
      deleteStartEvent: () => Promise.resolve(1),
    });

    expect(order).toEqual(["ready", "gameMain"]);
  });

  it("never logs member names or e-mail addresses", async () => {
    // Values that cannot collide with unrelated log text.
    const piiMembers = [
      { memberId: "m1", name: "NAME-ALPHA-9f2", email: "MAIL-BETA-4c1@x.io" },
    ];
    const { logger: capturing, text } = capturingLogger();

    await handleActor({
      event: { gameId: "game-1", members: piiMembers },
      eventKeyPrefix: "event:",
      awaiterKeyPrefix: "awaiter:",
      queueKeyPrefix: "queue:",
      lockKeyPrefix: "lock:",
      lifetimeSeconds: 30,
      gameMain: () => Promise.resolve(),
      logger: capturing,
      actorLogger: logger,
      redisConnection: fakeConnection,
      subsystem: newSubsystem(),
      saveStartEvent: () => Promise.resolve(true),
      deleteStartEvent: () => Promise.resolve(1),
    });

    const logged = text();
    // Positive control: the actor did log, and named the game.
    expect(logged).toContain("game-1");
    expect(logged).toContain("memberCount");
    for (const member of piiMembers) {
      expect(logged).not.toContain(member.name);
      expect(logged).not.toContain(member.email);
      expect(logged).not.toContain("ALPHA");
      expect(logged).not.toContain("BETA");
    }
  });
});
