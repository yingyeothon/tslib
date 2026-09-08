import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRedisSubscriber } from "../src/index.js";
import { startFakeRedis, type FakeRedis } from "./fake-redis.js";

const password = "subscriber-secret-9d4";

/** The confirmation Redis pushes for a `SUBSCRIBE`. */
function subscribed(channel: string): string {
  const bytes = Buffer.byteLength(channel, "utf-8");
  return `*3\r\n$9\r\nsubscribe\r\n$${bytes}\r\n${channel}\r\n:1\r\n`;
}

/** A `message` frame on a subscribed channel. */
function published(channel: string, payload: string): string {
  const channelBytes = Buffer.byteLength(channel, "utf-8");
  const payloadBytes = Buffer.byteLength(payload, "utf-8");
  return `*3\r\n$7\r\nmessage\r\n$${channelBytes}\r\n${channel}\r\n$${payloadBytes}\r\n${payload}\r\n`;
}

describe("subscriber recovery", () => {
  let fake: FakeRedis | undefined;
  const cleanups: Array<() => void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      cleanups.pop()!();
    }
    await fake?.close();
    fake = undefined;
  });

  it("drops a socket whose AUTH failed and authenticates on a new one", async () => {
    // A subscriber that stays on a connected-but-unauthenticated socket is
    // answered `-NOAUTH` forever and never tells anyone. Only the first
    // connection is refused here, so recovery is observable: the second one
    // authenticates and the subscription set is replayed onto it.
    fake = await startFakeRedis((command, { connection, client }) => {
      if (command.startsWith("AUTH")) {
        return connection === 1 ? "-ERR invalid password\r\n" : "+OK\r\n";
      }
      if (command.startsWith("SUBSCRIBE")) {
        if (connection === 1) {
          // What a real server answers an unauthenticated subscriber.
          return "-NOAUTH Authentication required.\r\n";
        }
        client.write(subscribed(command.slice("SUBSCRIBE ".length)));
      }
      return undefined;
    });

    const received: Array<{ channel: string; message: string }> = [];
    const reconnects: Array<{ channels: string[]; restored: boolean }> = [];
    const subscriber = createRedisSubscriber({
      host: "127.0.0.1",
      port: fake.port,
      password,
      timeoutMillis: 2000,
      connectionRetryInterval: 20,
      onMessage: (params) => received.push(params),
      onReconnected: (info) => reconnects.push(info),
    });
    cleanups.push(() => subscriber.disconnect());

    // The caller learns why, instead of waiting out a confirmation timeout
    // that never says the credential was refused.
    await expect(subscriber.subscribe("room:1")).rejects.toThrow(
      /invalid password/,
    );

    // The poisoned socket is gone and the subscriber came back on its own —
    // nothing else would have driven a reconnect.
    await vi.waitFor(() => expect(reconnects).toHaveLength(1), {
      timeout: 5000,
      interval: 10,
    });
    expect(reconnects[0]).toEqual({ channels: ["room:1"], restored: true });
    expect(fake.connections).toBe(2);
    // Connection 2 authenticated before it subscribed.
    expect(fake.received.slice(-2)).toEqual([
      `AUTH ${password}`,
      "SUBSCRIBE room:1",
    ]);

    // And the new socket really carries the stream.
    fake.clientAt(2)?.write(published("room:1", "hello"));
    await vi.waitFor(() => expect(received).toHaveLength(1), {
      timeout: 5000,
      interval: 10,
    });
    expect(received[0]).toEqual({ channel: "room:1", message: "hello" });
  });

  it("ignores a restore that outlived its socket", async () => {
    // Connection 1 accepts the AUTH and then dies without answering, so that
    // write is requeued and re-sent on connection 2 — where it is refused.
    // That rejection belongs to a socket nobody owns any more; acting on it
    // would reject the waiters of a subscription that is live and destroy
    // the healthy connection underneath them.
    let firstAuthOnSecond = true;
    fake = await startFakeRedis((command, { connection, client }) => {
      if (command.startsWith("AUTH")) {
        if (connection === 1) {
          // Take it, answer nothing, and drop the socket.
          setTimeout(() => client.destroy(), 20);
          return undefined;
        }
        if (firstAuthOnSecond) {
          firstAuthOnSecond = false;
          return "+OK\r\n";
        }
        // The replayed one from connection 1's restore.
        return "-LOADING Redis is loading the dataset in memory\r\n";
      }
      if (command.startsWith("SUBSCRIBE")) {
        client.write(subscribed(command.slice("SUBSCRIBE ".length)));
      }
      return undefined;
    });

    const received: Array<{ channel: string; message: string }> = [];
    const reconnects: Array<{ channels: string[]; restored: boolean }> = [];
    const subscriber = createRedisSubscriber({
      host: "127.0.0.1",
      port: fake.port,
      password,
      timeoutMillis: 2000,
      connectionRetryInterval: 20,
      onMessage: (params) => received.push(params),
      onReconnected: (info) => reconnects.push(info),
    });
    cleanups.push(() => subscriber.disconnect());

    await subscriber.subscribe("room:4");

    // Give the stale rejection time to arrive and be discarded.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fake.connections).toBe(2);
    expect(reconnects).toHaveLength(1);

    // Connection 2 is still the live one, and it still carries the stream.
    fake.clientAt(2)?.write(published("room:4", "still here"));
    await vi.waitFor(() => expect(received).toHaveLength(1), {
      timeout: 5000,
      interval: 10,
    });
    expect(received[0]).toEqual({ channel: "room:4", message: "still here" });
  });

  it("keeps trying while the credential stays refused", async () => {
    // Nothing else retries for a subscriber, so giving up would mean going
    // silent. Each attempt is a fresh connection with a fresh AUTH, paced by
    // `connectionRetryInterval`.
    fake = await startFakeRedis((command) =>
      command.startsWith("AUTH") ? "-ERR invalid password\r\n" : undefined,
    );

    const errors: unknown[][] = [];
    const subscriber = createRedisSubscriber({
      host: "127.0.0.1",
      port: fake.port,
      password,
      timeoutMillis: 2000,
      connectionRetryInterval: 20,
      logger: {
        severity: "error",
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: (...args: unknown[]) => errors.push(args),
      },
      onMessage: () => undefined,
    });
    cleanups.push(() => subscriber.disconnect());

    await expect(subscriber.subscribe("room:2")).rejects.toThrow(
      /invalid password/,
    );
    await vi.waitFor(() => expect(fake!.connections).toBeGreaterThan(2), {
      timeout: 5000,
      interval: 10,
    });

    // Every attempt says so, and none of them names the credential.
    // `JSON.stringify` renders an Error as `{}`, which would make the second
    // assertion pass however loudly the message leaked.
    const text = inspect(errors, { depth: 8 });
    expect(text).toContain("cannot restore its subscriptions");
    expect(text).toContain("invalid password");
    expect(text).not.toContain(password);
  });

  it("stops retrying once the subscriber is disconnected", async () => {
    // `disconnect` is the shutdown; the recovery loop must not outlive it.
    fake = await startFakeRedis((command) =>
      command.startsWith("AUTH") ? "-ERR invalid password\r\n" : undefined,
    );

    const subscriber = createRedisSubscriber({
      host: "127.0.0.1",
      port: fake.port,
      password,
      timeoutMillis: 2000,
      connectionRetryInterval: 20,
      onMessage: () => undefined,
    });
    await expect(subscriber.subscribe("room:3")).rejects.toThrow(
      /invalid password/,
    );
    subscriber.disconnect();

    const settled = fake.connections;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fake.connections).toBe(settled);
  });
});
