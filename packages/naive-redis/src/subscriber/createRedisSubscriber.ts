import { nullLogger, type Logger } from "@yingyeothon/logger";
import { ConnectionState, createNaiveSocket } from "@yingyeothon/naive-socket";
import { redisAuth } from "../auth.js";
import type { RedisConnection } from "../connection.js";
import { serializeCommand } from "../exchange/serialize.js";
import { incompletePushFrame, parsePushFrame } from "./pushFrame.js";

const newline = "\r\n";

export interface RedisSubscriberOptions {
  host: string;
  port?: number;
  /** ACL user name; sent as `AUTH <username> <password>` when set. */
  username?: string;
  password?: string;
  /** Timeout for the `AUTH` exchange. Default: 1000. */
  timeoutMillis?: number;
  /** Passed through to the underlying socket. */
  connectionRetryInterval?: number;
  logger?: Logger;
  /** Called for every `message` frame on a subscribed channel. */
  onMessage: (params: { channel: string; message: string }) => void;
}

export interface RedisSubscriber {
  subscribe: (channel: string) => Promise<void>;
  unsubscribe: (channel: string) => Promise<void>;
  /** Close the connection and forget every subscription. */
  disconnect: () => void;
}

/**
 * A Redis connection dedicated to subscriber mode.
 *
 * A subscriber cannot share the request/response connection built by
 * `createRedisConnection`: the server pushes messages at any time, with no
 * request to attribute them to. This owns its own socket, reads every
 * inbound frame through {@link parsePushFrame}, and re-authenticates and
 * re-subscribes after a reconnect.
 *
 * Only channel subscriptions are supported; patterns (`PSUBSCRIBE`) are not.
 */
export function createRedisSubscriber({
  host,
  port = 6379,
  username,
  password,
  timeoutMillis = 1000,
  connectionRetryInterval,
  logger = nullLogger,
  onMessage,
}: RedisSubscriberOptions): RedisSubscriber {
  const channels = new Set<string>();
  // Resolvers waiting for a `subscribe`/`unsubscribe` confirmation frame,
  // keyed by "<event>:<channel>".
  const waiters = new Map<string, Array<(error?: Error) => void>>();
  let everConnected = false;

  const socket = createNaiveSocket({
    host,
    port,
    logger,
    ...(connectionRetryInterval === undefined
      ? {}
      : { connectionRetryInterval }),
    onUnsolicitedData: consume,
    onConnectionStateChanged: ({ state }) => {
      if (state !== ConnectionState.Connected) {
        return;
      }
      // The first connection is driven by `subscribe` itself, so only a
      // reconnect has to replay the subscription set.
      const reconnected = everConnected;
      everConnected = true;
      restore(reconnected).catch((error: unknown) => {
        logger.error("Redis subscriber cannot restore its subscriptions", {
          error,
        });
      });
    },
  });
  const connection: RedisConnection = { socket, timeoutMillis };

  function consume(buffer: string): number {
    const { consumed, frame } = parsePushFrame(buffer);
    if (consumed === incompletePushFrame) {
      return incompletePushFrame;
    }
    if (frame?.kind === "message") {
      try {
        onMessage({ channel: frame.channel, message: frame.payload });
      } catch (error) {
        logger.error("Redis subscriber message handler failed", {
          channel: frame.channel,
          error,
        });
      }
    } else if (frame?.kind === "subscription") {
      settle(`${frame.event}:${frame.channel}`);
    }
    return consumed;
  }

  function settle(key: string, error?: Error): void {
    const pending = waiters.get(key);
    if (pending === undefined) {
      return;
    }
    waiters.delete(key);
    for (const resolve of pending) {
      resolve(error);
    }
  }

  /**
   * Resolves when Redis confirms the command, so callers can rely on it.
   *
   * The rejection handler is attached here rather than at the call site:
   * the timer can fire while the caller is still awaiting the write (an
   * unreachable Redis never completes it), and an unhandled rejection
   * terminates the process.
   */
  function confirmation(key: string): Promise<void> {
    const confirmed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        settle(key, new Error(`Timeout ${timeoutMillis}millis`));
      }, timeoutMillis);
      const pending = waiters.get(key) ?? [];
      pending.push((error) => {
        clearTimeout(timer);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
      waiters.set(key, pending);
    });
    confirmed.catch(() => undefined);
    return confirmed;
  }

  async function restore(reconnected: boolean): Promise<void> {
    if (password !== undefined) {
      // `redisAuth` sends urgently, so it precedes any queued subscribe.
      const authenticated = await redisAuth(connection, password, { username });
      if (!authenticated) {
        throw new Error("Invalid password");
      }
    }
    if (!reconnected) {
      return;
    }
    for (const channel of channels) {
      await sendCommand(["SUBSCRIBE", channel]);
    }
  }

  /**
   * Writes a subscriber-mode command. Its reply arrives on the push stream
   * rather than as this request's response, so the write itself is all this
   * waits for — bounded, so an unreachable server surfaces as a rejection
   * instead of hanging the caller forever.
   */
  function sendCommand(command: string[]): Promise<string> {
    const serialized = serializeCommand(command);
    return socket.send({
      message: serialized.endsWith(newline) ? serialized : serialized + newline,
      expectResponse: false,
      timeoutMillis,
    });
  }

  return {
    subscribe: async (channel) => {
      channels.add(channel);
      const confirmed = confirmation(`subscribe:${channel}`);
      await sendCommand(["SUBSCRIBE", channel]);
      await confirmed;
    },
    unsubscribe: async (channel) => {
      channels.delete(channel);
      const confirmed = confirmation(`unsubscribe:${channel}`);
      await sendCommand(["UNSUBSCRIBE", channel]);
      await confirmed;
    },
    disconnect: () => {
      channels.clear();
      for (const key of [...waiters.keys()]) {
        settle(key, new Error("DeadSocket"));
      }
      socket.disconnect();
    },
  };
}
