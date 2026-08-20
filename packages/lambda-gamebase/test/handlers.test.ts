import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { UserMessage } from "@yingyeothon/actor-system";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import type { RedisConnection } from "@yingyeothon/naive-redis";
import type { APIGatewayProxyEvent, APIGatewayProxyEventV2 } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRedisConnection,
  handleConnect,
  handleDebugStart,
  handleDisconnect,
  handleMessages,
  setRedisConnection,
  useRedis,
  type GameActorStartEvent,
} from "../src/index.js";

const fake = vi.hoisted(() => {
  const strings = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const state = { disconnects: 0, connects: 0 };
  function reset(): void {
    strings.clear();
    lists.clear();
    state.disconnects = 0;
    state.connects = 0;
  }
  return { strings, lists, state, reset };
});

vi.mock("@yingyeothon/naive-redis", () => {
  const list = (key: string): string[] => {
    let value = fake.lists.get(key);
    if (!value) {
      value = [];
      fake.lists.set(key, value);
    }
    return value;
  };
  return {
    redisConnect: vi.fn(() => {
      fake.state.connects++;
      return {
        socket: {
          disconnect: () => {
            fake.state.disconnects++;
          },
        },
        timeoutMillis: 1000,
      };
    }),
    redisGet: vi.fn((_c: unknown, key: string) =>
      Promise.resolve(fake.strings.get(key) ?? null),
    ),
    redisSet: vi.fn((_c: unknown, key: string, value: string) => {
      fake.strings.set(key, value);
      return Promise.resolve(true);
    }),
    redisDel: vi.fn((_c: unknown, ...keys: string[]) => {
      let count = 0;
      for (const key of keys) {
        if (fake.strings.delete(key)) count++;
        if (fake.lists.delete(key)) count++;
      }
      return Promise.resolve(count);
    }),
    redisRpush: vi.fn((_c: unknown, key: string, ...values: string[]) => {
      list(key).push(...values);
      return Promise.resolve(list(key).length);
    }),
    redisLrange: vi.fn(
      (_c: unknown, key: string, start: number, end: number = -1) => {
        const values = list(key);
        return Promise.resolve(
          values.slice(start, end === -1 ? undefined : end + 1),
        );
      },
    ),
    redisLtrim: vi.fn((_c: unknown, key: string, start: number, _end = -1) => {
      fake.lists.set(key, list(key).slice(start));
      return Promise.resolve(true);
    }),
    redisLlen: vi.fn((_c: unknown, key: string) =>
      Promise.resolve(list(key).length),
    ),
    redisLpop: vi.fn((_c: unknown, key: string) =>
      Promise.resolve(list(key).shift() ?? null),
    ),
    redisLindex: vi.fn((_c: unknown, key: string, index: number) =>
      Promise.resolve(list(key)[index] ?? null),
    ),
    redisExists: vi.fn(() => Promise.resolve(false)),
    redisIncr: vi.fn(() => Promise.resolve(1)),
    redisAuth: vi.fn(() => Promise.resolve(true)),
    redisSend: vi.fn(() => Promise.resolve("")),
  };
});

const logger: Logger = { ...nullLogger, severity: "none" };
const fakeConnection = {} as RedisConnection;

const startEvent: GameActorStartEvent = {
  gameId: "game-1",
  members: [
    { memberId: "m1", name: "one", email: "one@yyt.life" },
    { memberId: "m2", name: "two", email: "two@yyt.life" },
  ],
};

function connectionEvent(
  connectionId: string,
  headers: Record<string, string> = {},
  body?: string,
): APIGatewayProxyEvent {
  return {
    headers,
    queryStringParameters: null,
    requestContext: { connectionId },
    body: body ?? null,
  } as unknown as APIGatewayProxyEvent;
}

function queuedItems(keyPrefix: string, gameId: string): unknown[] {
  return (fake.lists.get(keyPrefix + gameId) ?? []).map(
    (each) => (JSON.parse(each) as UserMessage<unknown>).item,
  );
}

beforeEach(() => {
  fake.reset();
  setRedisConnection(undefined);
  vi.unstubAllEnvs();
});

describe("handleConnect", () => {
  const args = {
    connectionIdAndGameIdKeyPrefix: "conn:",
    actorEventKeyPrefix: "event:",
    actorQueueKeyPrefix: "queue:",
    logger,
    redisConnection: fakeConnection,
  };

  it("rejects a connection without game or member id", async () => {
    const result = await handleConnect({
      ...args,
      event: connectionEvent("c1", { "x-game-id": "game-1" }),
    });
    expect(result.statusCode).toBe(400);
  });

  it("rejects an unknown game", async () => {
    const result = await handleConnect({
      ...args,
      event: connectionEvent("c1", {
        "x-game-id": "game-x",
        "x-member-id": "m1",
      }),
    });
    expect(result.statusCode).toBe(400);
  });

  it("rejects a member not registered to the game", async () => {
    fake.strings.set("event:game-1", JSON.stringify(startEvent));
    const result = await handleConnect({
      ...args,
      event: connectionEvent("c1", {
        "x-game-id": "game-1",
        "x-member-id": "intruder",
      }),
    });
    expect(result.statusCode).toBe(400);
  });

  it("maps the connection and enqueues an enter message", async () => {
    fake.strings.set("event:game-1", JSON.stringify(startEvent));
    const result = await handleConnect({
      ...args,
      event: connectionEvent("c1", {
        "x-game-id": "game-1",
        "x-member-id": "m1",
      }),
    });
    expect(result.statusCode).toBe(200);
    expect(fake.strings.get("conn:c1")).toBe("game-1");
    expect(queuedItems("queue:", "game-1")).toEqual([
      { type: "enter", connectionId: "c1", memberId: "m1" },
    ]);
  });

  it("reads parameters from the query string as well", async () => {
    fake.strings.set("event:game-1", JSON.stringify(startEvent));
    const event = {
      ...connectionEvent("c2"),
      queryStringParameters: { "x-game-id": "game-1", "x-member-id": "m2" },
    } as unknown as APIGatewayProxyEvent;
    const result = await handleConnect({ ...args, event });
    expect(result.statusCode).toBe(200);
    expect(fake.strings.get("conn:c2")).toBe("game-1");
  });

  it("opens and closes a fresh connection when none is injected", async () => {
    fake.strings.set("event:game-1", JSON.stringify(startEvent));
    const { redisConnection: _omitted, ...rest } = args;
    const result = await handleConnect({
      ...rest,
      event: connectionEvent("c1", {
        "x-game-id": "game-1",
        "x-member-id": "m1",
      }),
    });
    expect(result.statusCode).toBe(200);
    expect(fake.state.connects).toBe(1);
    expect(fake.state.disconnects).toBe(1);
  });
});

describe("handleDisconnect", () => {
  const args = {
    connectionIdAndGameIdKeyPrefix: "conn:",
    actorQueueKeyPrefix: "queue:",
    logger,
    redisConnection: fakeConnection,
  };

  it("ignores a connection with no game mapping", async () => {
    const result = await handleDisconnect({
      ...args,
      event: connectionEvent("c1"),
    });
    expect(result.statusCode).toBe(200);
    expect(fake.lists.size).toBe(0);
  });

  it("enqueues a leave message and removes the mapping", async () => {
    fake.strings.set("conn:c1", "game-1");
    const result = await handleDisconnect({
      ...args,
      event: connectionEvent("c1"),
    });
    expect(result.statusCode).toBe(200);
    expect(queuedItems("queue:", "game-1")).toEqual([
      { type: "leave", connectionId: "c1" },
    ]);
    expect(fake.strings.has("conn:c1")).toBe(false);
  });

  it("opens and closes a fresh connection when none is injected", async () => {
    fake.strings.set("conn:c1", "game-1");
    const { redisConnection: _omitted, ...rest } = args;
    const result = await handleDisconnect({
      ...rest,
      event: connectionEvent("c1"),
    });
    expect(result.statusCode).toBe(200);
    expect(fake.state.connects).toBe(1);
    expect(fake.state.disconnects).toBe(1);
  });
});

describe("handleMessages", () => {
  const args = {
    connectionIdAndGameIdKeyPrefix: "conn:",
    actorQueueKeyPrefix: "queue:",
    validateMessage: (maybe: { type: string }) => maybe.type !== "invalid",
    logger,
    redisConnection: fakeConnection,
  };

  it("answers 404 without a body", async () => {
    const result = await handleMessages({
      ...args,
      event: connectionEvent("c1"),
    });
    expect(result.statusCode).toBe(404);
  });

  it("answers 404 for malformed JSON", async () => {
    const result = await handleMessages({
      ...args,
      event: connectionEvent("c1", {}, "{broken"),
    });
    expect(result.statusCode).toBe(404);
  });

  it("answers 404 when validation fails", async () => {
    const result = await handleMessages({
      ...args,
      event: connectionEvent("c1", {}, JSON.stringify({ type: "invalid" })),
    });
    expect(result.statusCode).toBe(404);
  });

  it("answers 404 when the connection has no game", async () => {
    const result = await handleMessages({
      ...args,
      event: connectionEvent("c1", {}, JSON.stringify({ type: "move" })),
    });
    expect(result.statusCode).toBe(404);
  });

  it("enqueues the message stamped with the connection id", async () => {
    fake.strings.set("conn:c1", "game-1");
    const result = await handleMessages({
      ...args,
      event: connectionEvent(
        "c1",
        {},
        JSON.stringify({ type: "move", x: 3, y: 4 }),
      ),
    });
    expect(result.statusCode).toBe(200);
    expect(queuedItems("queue:", "game-1")).toEqual([
      { type: "move", x: 3, y: 4, connectionId: "c1" },
    ]);
  });

  it("falls back to the shared connection when none is injected", async () => {
    fake.strings.set("conn:c1", "game-1");
    const { redisConnection: _omitted, ...rest } = args;
    const result = await handleMessages({
      ...rest,
      event: connectionEvent("c1", {}, JSON.stringify({ type: "move" })),
    });
    expect(result.statusCode).toBe(200);
    expect(fake.state.connects).toBe(1);
  });
});

describe("handleDebugStart", () => {
  const lambdaMock = mockClient(LambdaClient);

  function debugEvent(
    body: string | undefined,
    waitSetup = false,
  ): APIGatewayProxyEventV2 {
    return {
      body,
      queryStringParameters: waitSetup ? { waitSetup: "1" } : undefined,
    } as unknown as APIGatewayProxyEventV2;
  }

  beforeEach(() => {
    lambdaMock.reset();
    vi.stubEnv("IS_OFFLINE", "true");
    vi.stubEnv("GAME_ACTOR_LAMBDA_NAME", "game-actor");
  });

  it("answers 404 unless running offline", async () => {
    vi.stubEnv("IS_OFFLINE", "");
    const result = await handleDebugStart({
      event: debugEvent(JSON.stringify(startEvent)),
      actorLockKeyPrefix: "lock:",
      logger,
      redisConnection: fakeConnection,
    });
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it("answers 404 without a body", async () => {
    const result = await handleDebugStart({
      event: debugEvent(undefined),
      actorLockKeyPrefix: "lock:",
      logger,
      redisConnection: fakeConnection,
    });
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it("releases the actor lock and invokes the game actor lambda", async () => {
    fake.strings.set("lock:game-1", "1");
    lambdaMock.on(InvokeCommand).resolves({ StatusCode: 202 });

    const result = await handleDebugStart({
      event: debugEvent(JSON.stringify(startEvent), true),
      actorLockKeyPrefix: "lock:",
      logger,
      redisConnection: fakeConnection,
    });
    expect(result).toMatchObject({ statusCode: 200 });
    expect(fake.strings.has("lock:game-1")).toBe(false);

    const calls = lambdaMock.commandCalls(InvokeCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.FunctionName).toBe("game-actor");
    expect(input.InvocationType).toBe("Event");
    expect(input.Qualifier).toBe("$LATEST");
    expect(
      JSON.parse(Buffer.from(input.Payload as Uint8Array).toString("utf8")),
    ).toEqual(startEvent);
  });

  it("logs instead of failing when a fire-and-forget invoke rejects", async () => {
    lambdaMock.on(InvokeCommand).rejects(new Error("offline lambda is down"));
    const errorLog = vi.fn();

    const result = await handleDebugStart({
      event: debugEvent(JSON.stringify(startEvent)),
      actorLockKeyPrefix: "lock:",
      logger: { ...logger, error: errorLog },
      redisConnection: fakeConnection,
    });
    expect(result).toMatchObject({ statusCode: 200 });
    await vi.waitFor(() => expect(errorLog).toHaveBeenCalled());
  });

  it("fails when waitSetup is set and the invocation fails", async () => {
    lambdaMock.on(InvokeCommand).rejects(new Error("offline lambda is down"));
    await expect(
      handleDebugStart({
        event: debugEvent(JSON.stringify(startEvent), true),
        actorLockKeyPrefix: "lock:",
        logger,
        redisConnection: fakeConnection,
      }),
    ).rejects.toThrow("offline lambda is down");
  });
});

describe("newActorSubsys", () => {
  it("builds a working queue, lock, and awaiter on one connection", async () => {
    const { newActorSubsys } = await import("../src/index.js");
    const subsys = newActorSubsys({
      awaiterKeyPrefix: "awaiter:",
      queueKeyPrefix: "queue:",
      lockKeyPrefix: "lock:",
      lockTimeoutSeconds: 30,
      redisConnection: fakeConnection,
      logger,
    });

    expect(await subsys.lock.tryAcquire("game-1")).toBe(true);
    expect(fake.strings.has("lock:game-1")).toBe(true);
    expect(await subsys.lock.release("game-1")).toBe(true);
    expect(fake.strings.has("lock:game-1")).toBe(false);

    await subsys.queue.push("game-1", { value: 1 });
    expect(await subsys.queue.size("game-1")).toBe(1);
    expect(await subsys.queue.flush("game-1")).toEqual([{ value: 1 }]);

    expect(subsys.awaiter).toBeDefined();
    expect(subsys.logger).toBe(logger);
  });
});

describe("handleActor with the default Redis subsystem", () => {
  it("persists, runs, and clears the game using the shared connection", async () => {
    const { handleActor } = await import("../src/index.js");
    setRedisConnection(fakeConnection);

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
    });

    expect(gameMain).toHaveBeenCalledOnce();
    // The start event is stored while running and cleared at the end.
    expect(fake.strings.has("event:game-1")).toBe(false);
    // The actor lock is released after the loop.
    expect(fake.strings.has("lock:game-1")).toBe(false);
  });
});

describe("infra", () => {
  it("useRedis always disconnects, even on failure", async () => {
    vi.stubEnv("REDIS_HOST", "localhost");
    const result = await useRedis(() => Promise.resolve("done"));
    expect(result).toBe("done");
    expect(fake.state.disconnects).toBe(1);

    await expect(
      useRedis(() => Promise.reject(new Error("boom")), { host: "elsewhere" }),
    ).rejects.toThrow("boom");
    expect(fake.state.disconnects).toBe(2);
  });

  it("getRedisConnection caches the shared connection", () => {
    vi.stubEnv("REDIS_HOST", "localhost");
    setRedisConnection(undefined);
    const first = getRedisConnection();
    expect(getRedisConnection()).toBe(first);
    expect(fake.state.connects).toBe(1);

    setRedisConnection(fakeConnection);
    expect(getRedisConnection()).toBe(fakeConnection);
  });
});
