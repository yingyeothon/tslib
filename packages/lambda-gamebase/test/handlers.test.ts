import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { UserMessage } from "@yingyeothon/actor-system";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import type { RedisConnection } from "@yingyeothon/naive-redis";
import type { APIGatewayProxyEvent, APIGatewayProxyEventV2 } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { capturingLogger } from "./capturingLogger.js";
import {
  createActorSubsystem,
  createGamebaseContext,
  handleActor,
  handleConnect,
  handleDebugStart,
  handleDisconnect,
  handleMessages,
  useRedis,
  authorizeGameConnection,
  defaultConnectionMappingTtlMillis,
  type GameActorStartEvent,
} from "../src/index.js";

const fake = vi.hoisted(() => {
  const strings = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const expires: Array<{ key: string; seconds: number }> = [];
  const state = { disconnects: 0, connects: 0 };
  const self = {
    strings,
    lists,
    expires,
    state,
    failNextExpire: false,
    reset,
  };
  function reset(): void {
    strings.clear();
    lists.clear();
    expires.length = 0;
    self.failNextExpire = false;
    state.disconnects = 0;
    state.connects = 0;
  }
  return self;
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
    createRedisConnection: vi.fn(() => {
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
    redisExpire: vi.fn((_c: unknown, key: string, seconds: number) => {
      if (fake.failNextExpire) {
        fake.failNextExpire = false;
        return Promise.reject(new Error("connection reset"));
      }
      fake.expires.push({ key, seconds });
      return Promise.resolve(fake.strings.has(key) || fake.lists.has(key));
    }),
    // A tiny stand-in for the two compare-and-swap scripts the actor lock
    // uses: compare the stored value with ARGV[1], then delete or extend.
    redisEval: vi.fn(
      (
        _c: unknown,
        script: string,
        { keys = [], args = [] }: { keys?: string[]; args?: string[] } = {},
      ) => {
        const key = keys[0] ?? "";
        if (fake.strings.get(key) !== args[0]) {
          return Promise.resolve(0);
        }
        if (script.includes("DEL")) {
          fake.strings.delete(key);
        }
        return Promise.resolve(1);
      },
    ),
    redisExists: vi.fn(() => Promise.resolve(false)),
    redisIncr: vi.fn(() => Promise.resolve(1)),
    redisAuth: vi.fn(() => Promise.resolve(true)),
    redisSend: vi.fn(() => Promise.resolve("")),
  };
});

const logger: Logger = { ...nullLogger, severity: "none" };

/** Members whose name and email cannot collide with unrelated log text. */
const piiStartEvent: GameActorStartEvent = {
  gameId: "game-pii",
  members: [
    { memberId: "m1", name: "NAME-ALPHA-9f2", email: "alpha-9f2@yyt.life" },
    { memberId: "m2", name: "NAME-BETA-7c4", email: "beta-7c4@yyt.life" },
  ],
};
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

function newContext() {
  return createGamebaseContext({ redis: { host: "localhost" } });
}

beforeEach(() => {
  fake.reset();
});

describe("handleConnect", () => {
  const options = {
    connectionIdAndGameIdKeyPrefix: "conn:",
    actorEventKeyPrefix: "event:",
    actorQueueKeyPrefix: "queue:",
    logger,
    redisConnection: fakeConnection,
  };

  it("rejects a connection without game or member id", async () => {
    const result = await handleConnect({
      ...options,
      event: connectionEvent("c1", { "x-game-id": "game-1" }),
    });
    expect(result.statusCode).toBe(400);
  });

  it("rejects an unknown game", async () => {
    const result = await handleConnect({
      ...options,
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
      ...options,
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
      ...options,
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
    const result = await handleConnect({ ...options, event });
    expect(result.statusCode).toBe(200);
    expect(fake.strings.get("conn:c2")).toBe("game-1");
  });

  it("opens and closes a fresh connection from the context", async () => {
    fake.strings.set("event:game-1", JSON.stringify(startEvent));
    const { redisConnection: _omitted, ...rest } = options;
    const result = await handleConnect({
      ...rest,
      context: newContext(),
      event: connectionEvent("c1", {
        "x-game-id": "game-1",
        "x-member-id": "m1",
      }),
    });
    expect(result.statusCode).toBe(200);
    expect(fake.state.connects).toBe(1);
    expect(fake.state.disconnects).toBe(1);
  });

  it("fails fast without a redisConnection or context", async () => {
    const { redisConnection: _omitted, ...rest } = options;
    await expect(
      handleConnect({
        ...rest,
        event: connectionEvent("c1", {
          "x-game-id": "game-1",
          "x-member-id": "m1",
        }),
      }),
    ).rejects.toThrow("requires either redisConnection or context");
  });

  it("takes the member id from resolveMemberId instead of the header", async () => {
    fake.strings.set("event:game-1", JSON.stringify(startEvent));
    const event = {
      ...connectionEvent("c1", { "x-game-id": "game-1", "x-member-id": "m2" }),
      requestContext: { connectionId: "c1", authorizer: { memberId: "m1" } },
    } as unknown as APIGatewayProxyEvent;
    const result = await handleConnect({
      ...options,
      event,
      resolveMemberId: (e) => {
        const memberId = e.requestContext.authorizer?.["memberId"] as unknown;
        return typeof memberId === "string" ? memberId : undefined;
      },
    });
    expect(result.statusCode).toBe(200);
    // The forged "m2" header must not decide which slot the connection binds.
    expect(queuedItems("queue:", "game-1")).toEqual([
      { type: "enter", connectionId: "c1", memberId: "m1" },
    ]);
  });

  it("rejects the connection when resolveMemberId finds no identity", async () => {
    fake.strings.set("event:game-1", JSON.stringify(startEvent));
    const result = await handleConnect({
      ...options,
      event: connectionEvent("c1", {
        "x-game-id": "game-1",
        "x-member-id": "m1",
      }),
      resolveMemberId: () => undefined,
    });
    expect(result.statusCode).toBe(400);
    expect(queuedItems("queue:", "game-1")).toEqual([]);
  });

  it("reads headers case-insensitively", async () => {
    fake.strings.set("event:game-1", JSON.stringify(startEvent));
    const result = await handleConnect({
      ...options,
      event: connectionEvent("c1", {
        "X-GAME-ID": "game-1",
        "X-Member-Id": "m1",
      }),
    });
    expect(result.statusCode).toBe(200);
    expect(fake.strings.get("conn:c1")).toBe("game-1");
  });

  it("echoes the selected subprotocol so a browser handshake completes", async () => {
    fake.strings.set("event:game-1", JSON.stringify(startEvent));
    const offeredTo: string[][] = [];
    const result = await handleConnect({
      ...options,
      event: connectionEvent("c1", {
        "x-game-id": "game-1",
        "x-member-id": "m1",
        "Sec-WebSocket-Protocol": "bearer, a.b.c",
      }),
      selectSubprotocol: (offered) => {
        offeredTo.push([...offered]);
        return offered.includes("bearer") ? "bearer" : undefined;
      },
    });
    expect(result.statusCode).toBe(200);
    expect(result.headers).toEqual({ "Sec-WebSocket-Protocol": "bearer" });
    expect(offeredTo).toEqual([["bearer", "a.b.c"]]);
  });

  it("omits the subprotocol header when nothing is selected", async () => {
    fake.strings.set("event:game-1", JSON.stringify(startEvent));
    const result = await handleConnect({
      ...options,
      event: connectionEvent("c1", {
        "x-game-id": "game-1",
        "x-member-id": "m1",
      }),
      selectSubprotocol: (offered) =>
        offered.includes("bearer") ? "bearer" : undefined,
    });
    expect(result.statusCode).toBe(200);
    expect(result.headers).toBeUndefined();
  });

  it("names the member but not the start event when one is not registered", async () => {
    fake.strings.set("event:game-pii", JSON.stringify(piiStartEvent));
    const { logger: capturing, text } = capturingLogger();
    const result = await handleConnect({
      ...options,
      logger: capturing,
      event: connectionEvent("c1", {
        "x-game-id": "game-pii",
        "x-member-id": "intruder",
      }),
    });
    expect(result.statusCode).toBe(400);
    const logged = text();
    // Positive control: the rejection was logged at all.
    expect(logged).toContain("not registered member");
    for (const member of piiStartEvent.members) {
      expect(logged).not.toContain(member.name);
      expect(logged).not.toContain(member.email);
    }
    // The probing principal must stay attributable.
    expect(logged).toContain("intruder");
    expect(logged).toContain("c1");
  });

  it("ignores the authorizer context while resolveMemberId is unset", async () => {
    fake.strings.set("event:game-1", JSON.stringify(startEvent));
    const event = {
      ...connectionEvent("c1", { "x-game-id": "game-1", "x-member-id": "m1" }),
      requestContext: { connectionId: "c1", authorizer: { memberId: "m2" } },
    } as unknown as APIGatewayProxyEvent;
    const result = await handleConnect({ ...options, event });
    expect(result.statusCode).toBe(200);
    // No precedence flip: the default resolver still reads the header.
    expect(queuedItems("queue:", "game-1")).toEqual([
      { type: "enter", connectionId: "c1", memberId: "m1" },
    ]);
  });

  it("rejects an authenticated member for a game it is not a member of", async () => {
    fake.strings.set("event:game-1", JSON.stringify(startEvent));
    fake.strings.set(
      "event:game-2",
      JSON.stringify({ gameId: "game-2", members: [{ memberId: "m9" }] }),
    );
    const event = {
      ...connectionEvent("c1", { "x-game-id": "game-2" }),
      requestContext: { connectionId: "c1", authorizer: { memberId: "m1" } },
    } as unknown as APIGatewayProxyEvent;
    const result = await handleConnect({
      ...options,
      event,
      resolveMemberId: () => "m1",
    });
    // x-game-id is the one input still under the client's control.
    expect(result.statusCode).toBe(400);
    expect(queuedItems("queue:", "game-2")).toEqual([]);
  });

  it("refuses a subprotocol the client did not offer", async () => {
    fake.strings.set("event:game-1", JSON.stringify(startEvent));
    const { logger: capturing, text } = capturingLogger();
    const result = await handleConnect({
      ...options,
      logger: capturing,
      event: connectionEvent("c1", {
        "x-game-id": "game-1",
        "x-member-id": "m1",
        "Sec-WebSocket-Protocol": "bearer, a.secret.jwt",
      }),
      selectSubprotocol: () => "something-else",
    });
    expect(result.statusCode).toBe(200);
    expect(result.headers).toBeUndefined();
    const logged = text();
    expect(logged).toContain("selected subprotocol was not offered");
    // The offered list carries the credential; it must not reach the log.
    expect(logged).not.toContain("a.secret.jwt");
  });

  it("sends no subprotocol header on a refused handshake", async () => {
    fake.strings.set("event:game-1", JSON.stringify(startEvent));
    const result = await handleConnect({
      ...options,
      event: connectionEvent("c1", {
        "x-game-id": "game-1",
        "x-member-id": "intruder",
        "Sec-WebSocket-Protocol": "bearer, a.b.c",
      }),
      selectSubprotocol: (offered) =>
        offered.includes("bearer") ? "bearer" : undefined,
    });
    expect(result.statusCode).toBe(400);
    expect(result).not.toHaveProperty("headers");
  });

  it("returns a fresh response object each time", async () => {
    fake.strings.set("event:game-1", JSON.stringify(startEvent));
    const event = connectionEvent("c1", {
      "x-game-id": "game-1",
      "x-member-id": "m1",
    });
    const first = await handleConnect({ ...options, event });
    // A middy-style wrapper mutating the result must not poison the next
    // invocation in a warm container.
    (first as { headers?: Record<string, string> }).headers = { a: "b" };
    const second = await handleConnect({ ...options, event });
    expect(second).not.toHaveProperty("headers");
  });
});

describe("handleDisconnect", () => {
  const options = {
    connectionIdAndGameIdKeyPrefix: "conn:",
    actorQueueKeyPrefix: "queue:",
    logger,
    redisConnection: fakeConnection,
  };

  it("ignores a connection with no game mapping", async () => {
    const result = await handleDisconnect({
      ...options,
      event: connectionEvent("c1"),
    });
    expect(result.statusCode).toBe(200);
    expect(fake.lists.size).toBe(0);
  });

  it("enqueues a leave message and removes the mapping", async () => {
    fake.strings.set("conn:c1", "game-1");
    const result = await handleDisconnect({
      ...options,
      event: connectionEvent("c1"),
    });
    expect(result.statusCode).toBe(200);
    expect(queuedItems("queue:", "game-1")).toEqual([
      { type: "leave", connectionId: "c1" },
    ]);
    expect(fake.strings.has("conn:c1")).toBe(false);
  });

  it("opens and closes a fresh connection from the context", async () => {
    fake.strings.set("conn:c1", "game-1");
    const { redisConnection: _omitted, ...rest } = options;
    const result = await handleDisconnect({
      ...rest,
      context: newContext(),
      event: connectionEvent("c1"),
    });
    expect(result.statusCode).toBe(200);
    expect(fake.state.connects).toBe(1);
    expect(fake.state.disconnects).toBe(1);
  });
});

describe("handleMessages", () => {
  const options = {
    connectionIdAndGameIdKeyPrefix: "conn:",
    actorQueueKeyPrefix: "queue:",
    validateMessage: (maybe: { type: string }) => maybe.type !== "invalid",
    logger,
    redisConnection: fakeConnection,
  };

  it("answers 404 without a body", async () => {
    const result = await handleMessages({
      ...options,
      event: connectionEvent("c1"),
    });
    expect(result.statusCode).toBe(404);
  });

  it("answers 404 for malformed JSON", async () => {
    const result = await handleMessages({
      ...options,
      event: connectionEvent("c1", {}, "{broken"),
    });
    expect(result.statusCode).toBe(404);
  });

  it("answers 404 when validation fails", async () => {
    const result = await handleMessages({
      ...options,
      event: connectionEvent("c1", {}, JSON.stringify({ type: "invalid" })),
    });
    expect(result.statusCode).toBe(404);
  });

  it("answers 404 when the connection has no game", async () => {
    const result = await handleMessages({
      ...options,
      event: connectionEvent("c1", {}, JSON.stringify({ type: "move" })),
    });
    expect(result.statusCode).toBe(404);
  });

  it("enqueues the message stamped with the connection id", async () => {
    fake.strings.set("conn:c1", "game-1");
    const result = await handleMessages({
      ...options,
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

  it.each(["enter", "leave"])(
    "refuses the reserved %s type from a client",
    async (type) => {
      fake.strings.set("conn:c1", "game-1");
      const result = await handleMessages({
        ...options,
        event: connectionEvent(
          "c1",
          {},
          // Forging an enter used to rebind another member's game slot
          // to this connection.
          JSON.stringify({ type, memberId: "victim" }),
        ),
      });
      expect(result.statusCode).toBe(400);
      expect(queuedItems("queue:", "game-1")).toEqual([]);
    },
  );

  it("still accepts a game message that merely mentions a reserved type", async () => {
    fake.strings.set("conn:c1", "game-1");
    const result = await handleMessages({
      ...options,
      event: connectionEvent(
        "c1",
        {},
        JSON.stringify({ type: "chat", text: "enter the dungeon" }),
      ),
    });
    expect(result.statusCode).toBe(200);
    expect(queuedItems("queue:", "game-1")).toEqual([
      { type: "chat", text: "enter the dungeon", connectionId: "c1" },
    ]);
  });

  it("falls back to the context's shared connection when none is injected", async () => {
    fake.strings.set("conn:c1", "game-1");
    const { redisConnection: _omitted, ...rest } = options;
    const context = newContext();
    const result = await handleMessages({
      ...rest,
      context,
      event: connectionEvent("c1", {}, JSON.stringify({ type: "move" })),
    });
    expect(result.statusCode).toBe(200);
    expect(fake.state.connects).toBe(1);

    // The context reuses the same connection on the next invocation.
    await handleMessages({
      ...rest,
      context,
      event: connectionEvent("c1", {}, JSON.stringify({ type: "move" })),
    });
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

  const offlineContext = createGamebaseContext({
    redis: { host: "localhost" },
    isOffline: true,
    gameActorLambdaName: "game-actor",
  });

  beforeEach(() => {
    lambdaMock.reset();
  });

  it("answers 404 unless running offline", async () => {
    const result = await handleDebugStart({
      event: debugEvent(JSON.stringify(startEvent)),
      actorLockKeyPrefix: "lock:",
      context: createGamebaseContext({ isOffline: false }),
      logger,
      redisConnection: fakeConnection,
    });
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it("answers 404 without a body", async () => {
    const result = await handleDebugStart({
      event: debugEvent(undefined),
      actorLockKeyPrefix: "lock:",
      context: offlineContext,
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
      context: offlineContext,
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
      context: offlineContext,
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
        context: offlineContext,
        logger,
        redisConnection: fakeConnection,
      }),
    ).rejects.toThrow("offline lambda is down");
  });
});

describe("createActorSubsystem", () => {
  it("builds a working queue, lock, and awaiter on one connection", async () => {
    const subsystem = createActorSubsystem({
      awaiterKeyPrefix: "awaiter:",
      queueKeyPrefix: "queue:",
      lockKeyPrefix: "lock:",
      lockTimeoutSeconds: 30,
      redisConnection: fakeConnection,
      logger,
    });

    expect(await subsystem.lock.tryAcquire("game-1")).toBe(true);
    expect(fake.strings.has("lock:game-1")).toBe(true);
    expect(await subsystem.lock.release("game-1")).toBe(true);
    expect(fake.strings.has("lock:game-1")).toBe(false);

    await subsystem.queue.push("game-1", { value: 1 });
    expect(await subsystem.queue.size("game-1")).toBe(1);
    expect(await subsystem.queue.flush("game-1")).toEqual([{ value: 1 }]);

    expect(subsystem.awaiter).toBeDefined();
    expect(subsystem.logger).toBe(logger);
  });
});

describe("handleActor with the default Redis subsystem", () => {
  it("persists, runs, and clears the game using the context connection", async () => {
    const context = newContext();
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
      context,
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
    const result = await useRedis(() => Promise.resolve("done"), {
      host: "localhost",
    });
    expect(result).toBe("done");
    expect(fake.state.disconnects).toBe(1);

    await expect(
      useRedis(() => Promise.reject(new Error("boom")), { host: "elsewhere" }),
    ).rejects.toThrow("boom");
    expect(fake.state.disconnects).toBe(2);
  });

  it("createGamebaseContext caches the shared connection", () => {
    const context = newContext();
    const first = context.getRedisConnection();
    expect(context.getRedisConnection()).toBe(first);
    expect(fake.state.connects).toBe(1);
  });

  it("createGamebaseContext uses an injected connection", () => {
    const context = createGamebaseContext({ redisConnection: fakeConnection });
    expect(context.getRedisConnection()).toBe(fakeConnection);
    expect(fake.state.connects).toBe(0);
  });

  it("createGamebaseContext fails without redis options", () => {
    const context = createGamebaseContext({});
    expect(() => context.getRedisConnection()).toThrow(
      "GamebaseOptions.redis is required",
    );
  });
});

describe("authorizeGameConnection", () => {
  const startEvent: GameActorStartEvent = {
    gameId: "game-auth",
    members: [
      { memberId: "m1", name: "NAME-ALPHA-9f2", email: "MAIL-BETA-4c1@x.io" },
    ],
  };
  const get = (key: string): Promise<string | null> =>
    Promise.resolve(fake.strings.get(key) ?? null);

  it("authorizes a listed member and hands back the start event", async () => {
    fake.strings.set("event:game-auth", JSON.stringify(startEvent));

    const result = await authorizeGameConnection({
      gameId: "game-auth",
      memberId: "m1",
      eventKeyPrefix: "event:",
      get,
    });

    expect(result.authorized).toBe(true);
    expect(result.authorized && result.startEvent.gameId).toBe("game-auth");
  });

  it("refuses a gameId with no start event", async () => {
    const result = await authorizeGameConnection({
      gameId: "never-started",
      memberId: "m1",
      eventKeyPrefix: "event:",
      get,
    });

    expect(result).toEqual({ authorized: false, reason: "unknownGame" });
  });

  it("refuses a member the start event does not list", async () => {
    fake.strings.set("event:game-auth", JSON.stringify(startEvent));

    const result = await authorizeGameConnection({
      gameId: "game-auth",
      memberId: "intruder",
      eventKeyPrefix: "event:",
      get,
    });

    expect(result).toEqual({ authorized: false, reason: "notAMember" });
  });

  it("refuses a malformed start event rather than trusting it", async () => {
    fake.strings.set("event:game-auth", "{ not json");

    const result = await authorizeGameConnection({
      gameId: "game-auth",
      memberId: "m1",
      eventKeyPrefix: "event:",
      get,
    });

    expect(result).toEqual({ authorized: false, reason: "unknownGame" });
  });

  it("names the refused member and connection, never the roster", async () => {
    fake.strings.set("event:game-auth", JSON.stringify(startEvent));
    const { logger: capturing, text } = capturingLogger();

    await authorizeGameConnection({
      gameId: "game-auth",
      memberId: "intruder",
      eventKeyPrefix: "event:",
      get,
      connectionId: "c-99",
      logger: capturing,
    });

    const logged = text();
    // Positive control: the refusal was logged, and stays attributable.
    expect(logged).toContain("not registered member");
    expect(logged).toContain("intruder");
    expect(logged).toContain("c-99");
    expect(logged).toContain("memberCount");
    for (const member of startEvent.members) {
      expect(logged).not.toContain(member.name);
      expect(logged).not.toContain(member.email);
    }
    expect(logged).not.toContain("ALPHA");
    expect(logged).not.toContain("BETA");
  });
});

describe("connection mapping lifetime", () => {
  const startEvent: GameActorStartEvent = {
    gameId: "game-ttl",
    members: [{ memberId: "m1", name: "one", email: "one@yyt.life" }],
  };

  it("uses the documented default when unset", () => {
    expect(defaultConnectionMappingTtlMillis).toBe(900 * 1000);
  });

  it("refreshes the mapping in whole seconds on every inbound message", async () => {
    fake.strings.set("event:game-ttl", JSON.stringify(startEvent));
    fake.strings.set("c2g:c1", "game-ttl");

    await handleMessages<{ type: string }>({
      event: connectionEvent("c1", {}, JSON.stringify({ type: "move" })),
      connectionIdAndGameIdKeyPrefix: "c2g:",
      actorQueueKeyPrefix: "queue:",
      validateMessage: () => true,
      logger,
      redisConnection: fakeConnection,
      // A millisecond value that must not reach EXPIRE unrounded.
      connectionMappingTtlMillis: 1500,
    });

    expect(fake.expires).toEqual([{ key: "c2g:c1", seconds: 2 }]);
  });

  it("delivers the message even when the refresh fails", async () => {
    fake.strings.set("event:game-ttl", JSON.stringify(startEvent));
    fake.strings.set("c2g:c1", "game-ttl");
    const { logger: capturing, text } = capturingLogger();
    fake.failNextExpire = true;

    const result = await handleMessages<{ type: string }>({
      event: connectionEvent("c1", {}, JSON.stringify({ type: "move" })),
      connectionIdAndGameIdKeyPrefix: "c2g:",
      actorQueueKeyPrefix: "queue:",
      validateMessage: () => true,
      logger: capturing,
      redisConnection: fakeConnection,
    });

    // Housekeeping must not cost the player their message.
    expect(result.statusCode).toBe(200);
    expect(queuedItems("queue:", "game-ttl")).toEqual([
      { type: "move", connectionId: "c1" },
    ]);
    expect(text()).toContain("cannot refresh the connection mapping");
  });

  it("applies the queue ttl on the push, which is the only place it can be", async () => {
    fake.strings.set("event:game-ttl", JSON.stringify(startEvent));
    fake.strings.set("c2g:c1", "game-ttl");

    await handleMessages<{ type: string }>({
      event: connectionEvent("c1", {}, JSON.stringify({ type: "move" })),
      connectionIdAndGameIdKeyPrefix: "c2g:",
      actorQueueKeyPrefix: "queue:",
      validateMessage: () => true,
      logger,
      redisConnection: fakeConnection,
      queueTtlSeconds: 930,
    });

    // The actor never pushes, so a TTL configured on its own subsystem
    // would never be applied to the queue key at all.
    expect(fake.expires).toContainEqual({
      key: "queue:game-ttl",
      seconds: 930,
    });
  });

  it("sets no queue ttl when the producer does not ask for one", async () => {
    fake.strings.set("event:game-ttl", JSON.stringify(startEvent));
    fake.strings.set("c2g:c1", "game-ttl");

    await handleMessages<{ type: string }>({
      event: connectionEvent("c1", {}, JSON.stringify({ type: "move" })),
      connectionIdAndGameIdKeyPrefix: "c2g:",
      actorQueueKeyPrefix: "queue:",
      validateMessage: () => true,
      logger,
      redisConnection: fakeConnection,
    });

    expect(fake.expires.some((e) => e.key === "queue:game-ttl")).toBe(false);
  });
});
