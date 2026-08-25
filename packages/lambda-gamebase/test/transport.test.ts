import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  GoneException,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import { capturingLogger } from "./capturingLogger.js";
import {
  createRedisConnection,
  createRedisSubscriber,
  type RedisSubscriber,
} from "@yingyeothon/naive-redis";
import { mockClient } from "aws-sdk-client-mock";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from "vitest";
import {
  broadcast,
  createApiGatewayTransport,
  createRedisPubSubTransport,
  dropConnection,
  fakeConnectionId,
  reply,
  resolveTransport,
  type GatewayCommand,
  type Transport,
} from "../src/index.js";

const apiMock = mockClient(ApiGatewayManagementApiClient);
const logger: Logger = { ...nullLogger, severity: "none" };

beforeEach(() => {
  apiMock.reset();
});

/** Records what a game loop handed to the network layer. */
function recordingTransport(): Transport & {
  sent: Array<{ connectionId: string; message: unknown }>;
  dropped: string[];
} {
  const sent: Array<{ connectionId: string; message: unknown }> = [];
  const dropped: string[] = [];
  return {
    sent,
    dropped,
    send: (connectionId, message) => {
      sent.push({ connectionId, message });
      return Promise.resolve(true);
    },
    drop: (connectionId) => {
      dropped.push(connectionId);
      return Promise.resolve(true);
    },
  };
}

describe("resolveTransport", () => {
  it("prefers an explicit transport over a client", () => {
    const transport = recordingTransport();
    const client = {} as ApiGatewayManagementApiClient;
    expect(resolveTransport("reply", { transport, client })).toBe(transport);
  });

  it("fails fast with nothing to resolve", () => {
    expect(() => resolveTransport("reply", {})).toThrow(
      "reply requires either transport, client, or context",
    );
  });
});

describe("reply and dropConnection over an injected transport", () => {
  it("hands the message over without serializing it", async () => {
    const transport = recordingTransport();
    const message = { type: "snapshot", payload: { hp: 10 } };

    await expect(reply("connection-1", message, { transport })).resolves.toBe(
      true,
    );
    expect(transport.sent).toEqual([{ connectionId: "connection-1", message }]);
    // The transport owns encoding, so the value arrives unchanged.
    expect(transport.sent[0]?.message).toBe(message);
  });

  it("drops through the transport", async () => {
    const transport = recordingTransport();
    await expect(dropConnection("connection-1", { transport })).resolves.toBe(
      true,
    );
    expect(transport.dropped).toEqual(["connection-1"]);
  });

  it("keeps short-circuiting the fake connection id", async () => {
    const transport = recordingTransport();
    await expect(
      reply(fakeConnectionId, { type: "hi" }, { transport }),
    ).resolves.toBe(true);
    await expect(dropConnection(fakeConnectionId, { transport })).resolves.toBe(
      true,
    );
    expect(transport.sent).toEqual([]);
    expect(transport.dropped).toEqual([]);
  });

  it("broadcasts through the transport", async () => {
    const transport = recordingTransport();
    await expect(
      broadcast(["c1", "c2"], { type: "stage" }, { transport }),
    ).resolves.toEqual({ c1: true, c2: true });
    expect(transport.sent.map((s) => s.connectionId)).toEqual(["c1", "c2"]);
  });
});

/** A transport that can fan out in one call, like the pub/sub one. */
function fanOutTransport(delivered = true): Transport & {
  batches: Array<{ connectionIds: string[]; message: unknown }>;
  sent: string[];
} {
  const batches: Array<{ connectionIds: string[]; message: unknown }> = [];
  const sent: string[] = [];
  return {
    batches,
    sent,
    send: (connectionId) => {
      sent.push(connectionId);
      return Promise.resolve(true);
    },
    sendMany: (connectionIds, message) => {
      batches.push({ connectionIds, message });
      return Promise.resolve(delivered);
    },
    drop: () => Promise.resolve(true),
  };
}

describe("broadcast fan-out", () => {
  it("prefers sendMany over one send per connection", async () => {
    const transport = fanOutTransport();
    const message = { type: "stage" };

    await expect(
      broadcast(["c1", "c2", "c3"], message, { transport }),
    ).resolves.toEqual({ c1: true, c2: true, c3: true });

    expect(transport.batches).toEqual([
      { connectionIds: ["c1", "c2", "c3"], message },
    ]);
    expect(transport.sent).toEqual([]);
  });

  it("reports a failed fan-out for every connection in it", async () => {
    const transport = fanOutTransport(false);
    await expect(
      broadcast(["c1", "c2"], { type: "stage" }, { transport }),
    ).resolves.toEqual({ c1: false, c2: false });
  });

  it("keeps fake connections out of the fan-out", async () => {
    const transport = fanOutTransport();
    await expect(
      broadcast([fakeConnectionId, "c1"], { type: "stage" }, { transport }),
    ).resolves.toEqual({ [fakeConnectionId]: true, c1: true });

    expect(transport.batches).toEqual([
      { connectionIds: ["c1"], message: { type: "stage" } },
    ]);
  });

  it("touches no transport when every connection is simulated", async () => {
    const transport = fanOutTransport();
    await expect(
      broadcast([fakeConnectionId], { type: "stage" }, { transport }),
    ).resolves.toEqual({ [fakeConnectionId]: true });
    expect(transport.batches).toEqual([]);
    expect(transport.sent).toEqual([]);
  });

  it("resolves nothing to send without a transport at all", async () => {
    await expect(broadcast([], { type: "stage" })).resolves.toEqual({});
  });

  it("logs counts, never connection ids or the payload", async () => {
    const { logger: capturing, text: logged } = capturingLogger();
    const transport = fanOutTransport();

    await broadcast(
      ["CONN-ALPHA-9f2", "CONN-BETA-4c1"],
      { type: "stage", payload: { secret: "HP-GAMMA-7d3" } },
      { transport, logger: capturing },
    );

    const text = logged();
    // Positive control: it did log, and it named the message type.
    expect(text).toContain("broadcast");
    expect(text).toContain('"type":"stage"');
    expect(text).toContain('"total":2');
    expect(text).toContain('"delivered":2');
    expect(text).not.toContain("CONN-ALPHA-9f2");
    expect(text).not.toContain("ALPHA");
    expect(text).not.toContain("HP-GAMMA-7d3");
    expect(text).not.toContain("GAMMA");
  });
});

describe("createApiGatewayTransport", () => {
  it("posts JSON and deletes connections", async () => {
    apiMock.on(PostToConnectionCommand).resolves({});
    apiMock.on(DeleteConnectionCommand).resolves({});
    const transport = createApiGatewayTransport({
      client: new ApiGatewayManagementApiClient({}),
      logger,
    });

    await expect(transport.send("c1", { type: "hi", n: 1 })).resolves.toBe(
      true,
    );
    const post = apiMock.commandCalls(PostToConnectionCommand)[0];
    expect(post?.args[0].input).toEqual({
      ConnectionId: "c1",
      Data: JSON.stringify({ type: "hi", n: 1 }),
    });

    await expect(transport.drop("c1")).resolves.toBe(true);
    expect(apiMock.commandCalls(DeleteConnectionCommand)).toHaveLength(1);
  });

  it("reports a gone connection as undelivered but successfully dropped", async () => {
    apiMock
      .on(PostToConnectionCommand)
      .rejects(new GoneException({ $metadata: {}, message: "gone" }));
    apiMock
      .on(DeleteConnectionCommand)
      .rejects(new GoneException({ $metadata: {}, message: "gone" }));
    const transport = createApiGatewayTransport({
      client: new ApiGatewayManagementApiClient({}),
      logger,
    });

    await expect(transport.send("c1", { type: "hi" })).resolves.toBe(false);
    await expect(transport.drop("c1")).resolves.toBe(true);
  });

  it("passes an abort signal when a send timeout is set", async () => {
    const send = vi.fn().mockResolvedValue({});
    const transport = createApiGatewayTransport({
      client: { send } as unknown as ApiGatewayManagementApiClient,
      sendTimeoutMillis: 250,
      logger,
    });

    await transport.send("c1", { type: "hi" });
    const [, options] = send.mock.calls[0] as [
      unknown,
      { abortSignal?: AbortSignal },
    ];
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("sends no abort signal without a timeout", async () => {
    const send = vi.fn().mockResolvedValue({});
    const transport = createApiGatewayTransport({
      client: { send } as unknown as ApiGatewayManagementApiClient,
      logger,
    });

    await transport.send("c1", { type: "hi" });
    const [, options] = send.mock.calls[0] as [unknown, object];
    expect(options).toEqual({});
  });

  it("reports an aborted send as undelivered", async () => {
    const abortError = new Error("Request aborted");
    abortError.name = "AbortError";
    const transport = createApiGatewayTransport({
      client: {
        send: vi.fn().mockRejectedValue(abortError),
      } as unknown as ApiGatewayManagementApiClient,
      sendTimeoutMillis: 1,
      logger,
    });

    await expect(transport.send("c1", { type: "hi" })).resolves.toBe(false);
  });

  it("fails fast without a client or context", async () => {
    const transport = createApiGatewayTransport({ logger });
    await expect(transport.send("c1", { type: "hi" })).rejects.toThrow(
      "reply requires either client or context",
    );
    await expect(transport.drop("c1")).rejects.toThrow(
      "dropConnection requires either client or context",
    );
  });
});

describe("createRedisPubSubTransport", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()!();
    }
  });

  function redisOptions() {
    return { host: inject("redisHost"), port: inject("redisPort") };
  }

  function newSubscriber(received: GatewayCommand[]): RedisSubscriber {
    const subscriber = createRedisSubscriber({
      ...redisOptions(),
      timeoutMillis: 5000,
      onMessage: ({ message }) =>
        received.push(JSON.parse(message) as GatewayCommand),
    });
    cleanups.push(() => subscriber.disconnect());
    return subscriber;
  }

  function newTransport(gameId: string): Transport {
    const connection = createRedisConnection(redisOptions());
    cleanups.push(() => connection.socket.disconnect());
    return createRedisPubSubTransport({
      connection,
      channelPrefix: "game:out:",
      gameId,
      logger,
    });
  }

  it("publishes send and drop commands a gateway can consume", async () => {
    const received: GatewayCommand[] = [];
    const subscriber = newSubscriber(received);
    await subscriber.subscribe("game:out:game-1");

    const transport = newTransport("game-1");
    const message = { type: "snapshot", payload: { 방: "던전", hp: 10 } };
    await expect(transport.send("connection-1", message)).resolves.toBe(true);
    await expect(transport.drop("connection-1")).resolves.toBe(true);

    await vi.waitFor(() => expect(received).toHaveLength(2), {
      timeout: 10_000,
      interval: 20,
    });
    expect(received).toEqual([
      { op: "send", connectionId: "connection-1", message },
      { op: "drop", connectionId: "connection-1" },
    ]);
  });

  it("survives a payload carrying the RESP delimiter", async () => {
    const received: GatewayCommand[] = [];
    const subscriber = newSubscriber(received);
    await subscriber.subscribe("game:out:game-2");

    const transport = newTransport("game-2");
    const message = { type: "chat", text: "first\r\nsecond\r\n안녕 🎮" };
    await transport.send("connection-1", message);

    await vi.waitFor(() => expect(received).toHaveLength(1), {
      timeout: 10_000,
      interval: 20,
    });
    expect(received[0]).toEqual({
      op: "send",
      connectionId: "connection-1",
      message,
    });
  });

  it("reports false when no gateway is listening", async () => {
    const transport = newTransport("game-nobody");
    await expect(transport.send("connection-1", { type: "hi" })).resolves.toBe(
      false,
    );
  });

  it("reports false when publishing fails", async () => {
    const connection = createRedisConnection(redisOptions());
    const transport = createRedisPubSubTransport({
      connection,
      channelPrefix: "game:out:",
      gameId: "game-dead",
      logger,
    });
    // A dead connection makes the PUBLISH itself throw, which must not
    // escape into the game loop.
    connection.socket.disconnect();

    await expect(transport.send("c1", { type: "hi" })).resolves.toBe(false);
    await expect(transport.drop("c1")).resolves.toBe(false);
  });

  it("warns with a target count, never the connection ids", async () => {
    const { logger: capturing, text } = capturingLogger();
    const connection = createRedisConnection(redisOptions());
    cleanups.push(() => connection.socket.disconnect());
    const transport = createRedisPubSubTransport({
      connection,
      channelPrefix: "game:out:",
      gameId: "game-unheard",
      logger: capturing,
    });

    // Nobody is subscribed to this channel.
    await expect(
      broadcast(
        ["CONN-ALPHA-9f2", "CONN-BETA-4c1"],
        { type: "t" },
        {
          transport,
        },
      ),
    ).resolves.toEqual({ "CONN-ALPHA-9f2": false, "CONN-BETA-4c1": false });

    const logged = text();
    // Positive control: the missing gateway was reported, with a count.
    expect(logged).toContain("no gateway is listening");
    expect(logged).toContain('"targets":2');
    expect(logged).not.toContain("CONN-ALPHA-9f2");
    expect(logged).not.toContain("ALPHA");
  });

  it("drives a game broadcast end to end in one publish", async () => {
    const received: GatewayCommand[] = [];
    const subscriber = newSubscriber(received);
    await subscriber.subscribe("game:out:game-3");

    const transport = newTransport("game-3");
    await expect(
      broadcast(["c1", "c2"], { type: "stage" }, { transport }),
    ).resolves.toEqual({ c1: true, c2: true });

    await vi.waitFor(() => expect(received).toHaveLength(1), {
      timeout: 10_000,
      interval: 20,
    });
    // The whole party rides one PUBLISH; the gateway does the fan-out.
    const command = received[0];
    expect(command?.op).toBe("send");
    expect(
      command && "connectionIds" in command ? command.connectionIds : [],
    ).toEqual(["c1", "c2"]);
  });

  it("still sends one command per connection through reply", async () => {
    const received: GatewayCommand[] = [];
    const subscriber = newSubscriber(received);
    await subscriber.subscribe("game:out:game-4");

    const transport = newTransport("game-4");
    await expect(reply("c1", { type: "hi" }, { transport })).resolves.toBe(
      true,
    );

    await vi.waitFor(() => expect(received).toHaveLength(1), {
      timeout: 10_000,
      interval: 20,
    });
    expect(received[0]).toMatchObject({
      op: "send",
      connectionId: "c1",
      message: { type: "hi" },
    });
  });
});
