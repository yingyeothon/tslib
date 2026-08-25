import { nullLogger } from "@yingyeothon/logger";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRedisConnection,
  createRedisSubscriber,
  redisExists,
  redisPublish,
  redisSend,
  redisSet,
  type RedisConnection,
  type RedisSubscriber,
  type RedisSubscriberOptions,
} from "../src/index.js";
import { redisConnectionOptionsFromEnv } from "./fixture.js";

interface Received {
  channel: string;
  message: string;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()!();
  }
});

function newSubscriber(
  received: Received[],
  options: Partial<RedisSubscriberOptions> = {},
): RedisSubscriber {
  const { host, port } = redisConnectionOptionsFromEnv();
  const subscriber = createRedisSubscriber({
    host,
    port,
    timeoutMillis: 5000,
    onMessage: (params) => received.push(params),
    ...options,
  });
  cleanups.push(() => subscriber.disconnect());
  return subscriber;
}

function newConnection(): RedisConnection {
  const connection = createRedisConnection(redisConnectionOptionsFromEnv());
  cleanups.push(() => connection.socket.disconnect());
  return connection;
}

async function configSetRequirepass(
  connection: RedisConnection,
  password: string,
  value: string,
): Promise<void> {
  await redisSend({
    connection,
    commands: [
      password === ""
        ? `CONFIG SET requirepass "${value}"`
        : `AUTH ${password}`,
    ],
    match: (m) => m.capture("\r\n"),
    transform: (result) => result[0],
  });
  if (password !== "") {
    await redisSend({
      connection,
      commands: [`CONFIG SET requirepass "${value}"`],
      match: (m) => m.capture("\r\n"),
      transform: (result) => result[0],
    });
  }
}

function waitForMessages(received: Received[], count: number): Promise<void> {
  return vi.waitFor(() => expect(received).toHaveLength(count), {
    timeout: 10_000,
    interval: 20,
  });
}

describe("publish and subscribe", () => {
  it("delivers a published message to a subscriber", async () => {
    const received: Received[] = [];
    const subscriber = newSubscriber(received);
    await subscriber.subscribe("room:1");

    const publisher = newConnection();
    // The subscription is confirmed by now, so nobody can miss this.
    await expect(redisPublish(publisher, "room:1", "hello")).resolves.toBe(1);

    await waitForMessages(received, 1);
    expect(received[0]).toEqual({ channel: "room:1", message: "hello" });
  });

  it("keeps multi-byte and delimiter-bearing payloads intact", async () => {
    const payloads = [
      "안녕하세요, 던전에 오신 것을 환영합니다",
      "line-one\r\nline-two\r\n",
      "🎮 emoji 🎲 mixed 한글",
      JSON.stringify({ op: "send", message: { text: "가나다\r\n라마바" } }),
    ];
    const received: Received[] = [];
    const subscriber = newSubscriber(received);
    await subscriber.subscribe("room:2");

    const publisher = newConnection();
    for (const payload of payloads) {
      await redisPublish(publisher, "room:2", payload);
    }

    await waitForMessages(received, payloads.length);
    expect(received.map((r) => r.message)).toEqual(payloads);
  });

  it("does not let a payload inject another command", async () => {
    const received: Received[] = [];
    const subscriber = newSubscriber(received);
    await subscriber.subscribe("room:3");

    const publisher = newConnection();
    await redisSet(publisher, "survivor", "still-here");
    const injection = '"\r\nFLUSHALL\r\n';
    await redisPublish(publisher, "room:3", injection);

    await waitForMessages(received, 1);
    expect(received[0]?.message).toBe(injection);
    // FLUSHALL never ran, so the key set before the publish is intact.
    await expect(redisExists(publisher, "survivor")).resolves.toBe(1);
  });

  it("routes each channel separately", async () => {
    const received: Received[] = [];
    const subscriber = newSubscriber(received);
    await subscriber.subscribe("room:a");
    await subscriber.subscribe("room:b");

    const publisher = newConnection();
    await redisPublish(publisher, "room:a", "for-a");
    await redisPublish(publisher, "room:b", "for-b");
    await redisPublish(publisher, "room:c", "nobody-listens");

    await waitForMessages(received, 2);
    expect(received).toEqual([
      { channel: "room:a", message: "for-a" },
      { channel: "room:b", message: "for-b" },
    ]);
  });

  it("subscribes to a channel that needs the RESP array form", async () => {
    // A space forces `serializeCommand` off the inline path.
    const channel = "room with space";
    const received: Received[] = [];
    const subscriber = newSubscriber(received);
    await subscriber.subscribe(channel);

    const publisher = newConnection();
    await expect(redisPublish(publisher, channel, "spaced")).resolves.toBe(1);

    await waitForMessages(received, 1);
    expect(received[0]).toEqual({ channel, message: "spaced" });
  });

  it("stops delivering after unsubscribe", async () => {
    const received: Received[] = [];
    const subscriber = newSubscriber(received);
    await subscriber.subscribe("room:4");

    const publisher = newConnection();
    await redisPublish(publisher, "room:4", "before");
    await waitForMessages(received, 1);

    await subscriber.unsubscribe("room:4");
    await expect(redisPublish(publisher, "room:4", "after")).resolves.toBe(0);

    expect(received).toHaveLength(1);
  });

  it("re-authenticates and re-subscribes after losing the connection", async () => {
    const received: Received[] = [];
    const subscriber = newSubscriber(received, {
      connectionRetryInterval: 50,
    });
    await subscriber.subscribe("room:5");

    const publisher = newConnection();
    await redisPublish(publisher, "room:5", "before-kill");
    await waitForMessages(received, 1);

    // Drop every subscriber connection server-side; the client queue is
    // empty at this point, which used to stop the reconnect.
    await redisSend({
      connection: publisher,
      commands: ["CLIENT KILL TYPE pubsub"],
      match: (m) => m.capture("\r\n"),
      transform: (result) => result[0],
    });

    // Publish until one lands: the resubscribe races the reconnect.
    await vi.waitFor(
      async () => {
        await redisPublish(publisher, "room:5", "after-kill");
        expect(received.some((r) => r.message === "after-kill")).toBe(true);
      },
      { timeout: 10_000, interval: 100 },
    );
  });

  it("reports a reconnect so a consumer can resynchronise", async () => {
    const received: Received[] = [];
    const reconnects: Array<{ channels: string[]; restored: boolean }> = [];
    const subscriber = newSubscriber(received, {
      connectionRetryInterval: 50,
      onReconnected: (info) => reconnects.push(info),
    });
    await subscriber.subscribe("room:6");

    const publisher = newConnection();
    await redisPublish(publisher, "room:6", "before-kill");
    await waitForMessages(received, 1);

    // The first connection is not a reconnect, so nothing has fired yet.
    expect(reconnects).toEqual([]);

    await redisSend({
      connection: publisher,
      commands: ["CLIENT KILL TYPE pubsub"],
      match: (m) => m.capture("\r\n"),
      transform: (result) => result[0],
    });

    await vi.waitFor(() => expect(reconnects.length).toBeGreaterThan(0), {
      timeout: 10_000,
      interval: 50,
    });
    // The gap is announced with the channels that were replayed, which is
    // what a consumer needs to resend anything published one-shot.
    expect(reconnects[0]).toEqual({ channels: ["room:6"], restored: true });
  });

  it("still reports a reconnect whose replay failed", async () => {
    const password = "pubsub-reconnect-password-1234";
    const admin = newConnection();
    await configSetRequirepass(admin, "", password);
    try {
      const received: Received[] = [];
      const reconnects: Array<{ channels: string[]; restored: boolean }> = [];
      const subscriber = newSubscriber(received, {
        password,
        connectionRetryInterval: 50,
        onReconnected: (info) => reconnects.push(info),
      });
      await subscriber.subscribe("room:7");

      // Rotate the password, then kill the connection: the replay's AUTH
      // now fails, and the application has to hear about the gap anyway.
      await configSetRequirepass(admin, password, "a-different-password");
      await redisSend({
        connection: admin,
        commands: ["CLIENT KILL TYPE pubsub"],
        match: (m) => m.capture("\r\n"),
        transform: (result) => result[0],
      });

      await vi.waitFor(() => expect(reconnects.length).toBeGreaterThan(0), {
        timeout: 10_000,
        interval: 50,
      });
      expect(reconnects[0]?.restored).toBe(false);
      expect(reconnects[0]?.channels).toEqual(["room:7"]);
    } finally {
      await configSetRequirepass(admin, "a-different-password", "");
    }
  });

  it("survives a reconnect handler that throws", async () => {
    const errors: unknown[][] = [];
    const received: Received[] = [];
    const subscriber = newSubscriber(received, {
      connectionRetryInterval: 50,
      logger: {
        ...nullLogger,
        error: (...args: unknown[]) => errors.push(args),
      },
      onReconnected: () => {
        throw new Error("consumer bug");
      },
    });
    await subscriber.subscribe("room:8");

    const publisher = newConnection();
    await redisSend({
      connection: publisher,
      commands: ["CLIENT KILL TYPE pubsub"],
      match: (m) => m.capture("\r\n"),
      transform: (result) => result[0],
    });

    await vi.waitFor(
      () =>
        expect(
          errors.some((line) =>
            line.some((arg) =>
              String(JSON.stringify(arg)).includes("reconnect handler"),
            ),
          ),
        ).toBe(true),
      { timeout: 10_000, interval: 50 },
    );

    // A throwing consumer must not stop delivery.
    await vi.waitFor(
      async () => {
        await redisPublish(publisher, "room:8", "after-throw");
        expect(received.some((r) => r.message === "after-throw")).toBe(true);
      },
      { timeout: 10_000, interval: 100 },
    );
  });

  it("re-authenticates with a password after losing the connection", async () => {
    const password = "pubsub-test-password-1234";
    const admin = newConnection();
    await configSetRequirepass(admin, "", password);
    try {
      const received: Received[] = [];
      const subscriber = newSubscriber(received, {
        password,
        connectionRetryInterval: 50,
      });
      await subscriber.subscribe("room:7");

      const publisher = createRedisConnection({
        ...redisConnectionOptionsFromEnv(),
        password,
      });
      cleanups.push(() => publisher.socket.disconnect());
      await redisPublish(publisher, "room:7", "before-kill");
      await waitForMessages(received, 1);

      await redisSend({
        connection: publisher,
        commands: ["CLIENT KILL TYPE pubsub"],
        match: (m) => m.capture("\r\n"),
        transform: (result) => result[0],
      });

      // The reconnect has to AUTH again before Redis accepts SUBSCRIBE.
      await vi.waitFor(
        async () => {
          await redisPublish(publisher, "room:7", "after-kill");
          expect(received.some((r) => r.message === "after-kill")).toBe(true);
        },
        { timeout: 10_000, interval: 100 },
      );
    } finally {
      await configSetRequirepass(admin, password, "");
    }
  });

  it("rejects instead of crashing when the server never answers", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const subscriber = createRedisSubscriber({
        host: "127.0.0.1",
        // Nothing listens here, so the write never completes and the
        // confirmation timer fires while the caller is still awaiting it.
        port: 1,
        timeoutMillis: 200,
        connectionRetryInterval: -1,
        onMessage: () => undefined,
      });
      cleanups.push(() => subscriber.disconnect());

      await expect(subscriber.subscribe("room:8")).rejects.toThrow(/Timeout/);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("reassembles a message split across TCP chunks", async () => {
    const received: Received[] = [];
    const subscriber = newSubscriber(received);
    await subscriber.subscribe("room:9");

    // Large enough that Redis writes it in several chunks, and multi-byte
    // so a naive per-chunk decode would corrupt it.
    const payload = "던전🎮".repeat(20_000);
    const publisher = newConnection();
    await redisPublish(publisher, "room:9", payload);

    await waitForMessages(received, 1);
    expect(received[0]?.message).toBe(payload);
  });

  it("keeps framing after a handler throws", async () => {
    const received: Received[] = [];
    const subscriber = newSubscriber(received, {
      onMessage: (params) => {
        received.push(params);
        if (params.message === "boom") {
          throw new Error("handler failed");
        }
      },
    });
    await subscriber.subscribe("room:6");

    const publisher = newConnection();
    await redisPublish(publisher, "room:6", "boom");
    await redisPublish(publisher, "room:6", "still-works");

    await waitForMessages(received, 2);
    expect(received.map((r) => r.message)).toEqual(["boom", "still-works"]);
  });
});
