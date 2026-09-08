import { nullLogger, type Logger } from "@yingyeothon/logger";
import {
  ConnectionState,
  createNaiveSocket,
  type TlsOptions,
} from "@yingyeothon/naive-socket";
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
  /**
   * Budget for the `AUTH` exchange and for a subscribe/unsubscribe
   * confirmation. Default 5000, matching `createRedisConnection`: this
   * `AUTH` is the first command on a fresh socket, so it also pays for the
   * TCP and TLS handshake, and 1000 could not cover a cold container.
   */
  timeoutMillis?: number;
  /** Passed through to the underlying socket. */
  connectionRetryInterval?: number;
  /**
   * Wraps this connection in TLS. A subscriber owns its own socket and
   * sends its own `AUTH`, so leaving it unset while the request/response
   * connection uses TLS puts the same credential on the wire in the clear.
   */
  tls?: boolean | TlsOptions;
  logger?: Logger;
  /** Called for every `message` frame on a subscribed channel. */
  onMessage: (params: { channel: string; message: string }) => void;
  /**
   * Called after a reconnect has replayed the subscription set, with
   * `restored: false` when the replay failed.
   *
   * Nothing published during the gap is redelivered. That is harmless for
   * self-contained snapshot frames, which the next one heals, and not
   * harmless for one-shot commands — so a consumer that has any needs this
   * to resynchronise rather than to assume continuity.
   */
  onReconnected?: (params: { channels: string[]; restored: boolean }) => void;
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
  timeoutMillis = 5000,
  connectionRetryInterval,
  tls,
  logger = nullLogger,
  onMessage,
  onReconnected,
}: RedisSubscriberOptions): RedisSubscriber {
  const channels = new Set<string>();
  // Resolvers waiting for a `subscribe`/`unsubscribe` confirmation frame,
  // keyed by "<event>:<channel>".
  const waiters = new Map<string, Array<(error?: Error) => void>>();
  let everConnected = false;
  /**
   * Counts connections, so a `restore` can tell whether it still owns the
   * socket when it finishes. A stale one is not merely redundant: acting on
   * its outcome would settle the current connection's waiters and reset a
   * healthy socket — the hazard `createRedisConnection` guards the same way.
   */
  let generation = 0;

  const socket = createNaiveSocket({
    host,
    port,
    logger,
    ...(connectionRetryInterval === undefined
      ? {}
      : { connectionRetryInterval }),
    ...(tls !== undefined ? { tls } : {}),
    onUnsolicitedData: consume,
    onConnectionStateChanged: ({ state }) => {
      if (state !== ConnectionState.Connected) {
        return;
      }
      // The first connection is driven by `subscribe` itself, so only a
      // reconnect has to replay the subscription set.
      const reconnected = everConnected;
      everConnected = true;
      const mine = ++generation;
      restore(reconnected, mine)
        .then(() => {
          if (mine !== generation) {
            return;
          }
          notifyReconnected(reconnected, true);
        })
        .catch((cause: unknown) => {
          const error =
            cause instanceof Error ? cause : new Error(String(cause));
          if (mine !== generation) {
            // A `restore` that outlived its socket. Its `AUTH` was requeued
            // onto the next connection, so this rejection says nothing about
            // the socket in hand — and acting on it would reject the waiters
            // of a subscription that is live and destroy a healthy
            // connection.
            logger.warn("Redis subscriber discarded a stale restore", {
              error,
            });
            return;
          }
          logger.error("Redis subscriber cannot restore its subscriptions", {
            error,
          });
          // A socket whose `AUTH` failed answers `-NOAUTH` to everything for
          // the rest of its life, and one whose replay broke off has a
          // subscription set the server does not agree with; either way its
          // receive buffer may still hold a reply nothing is waiting for.
          // Drop it and let the socket reconnect on its own schedule — a
          // subscriber has no caller-driven retry to fall back on, so
          // `disconnect` here would leave it silent forever.
          //
          // The waiters are settled with the real cause first, so an
          // in-flight `subscribe` reports "Invalid password" rather than the
          // confirmation timeout it used to wait out. The same cause is
          // handed to `reset`, so a caller still awaiting the write sees it
          // too.
          settleAll(error);
          socket.reset(error);
          notifyReconnected(reconnected, false);
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

  function notifyReconnected(reconnected: boolean, restored: boolean): void {
    if (!reconnected || onReconnected === undefined) {
      return;
    }
    try {
      onReconnected({ channels: [...channels], restored });
    } catch (error) {
      logger.error("Redis subscriber reconnect handler failed", { error });
    }
  }

  /** Settles every pending confirmation, for a connection that is going. */
  function settleAll(error: Error): void {
    for (const key of [...waiters.keys()]) {
      settle(key, error);
    }
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

  async function restore(reconnected: boolean, mine: number): Promise<void> {
    if (password !== undefined) {
      // `redisAuth` sends urgently, so it precedes any queued subscribe.
      const authenticated = await redisAuth(connection, password, { username });
      if (!authenticated) {
        throw new Error("Invalid password");
      }
    }
    // The `AUTH` above may have been answered by a socket this restore no
    // longer owns — a pending write survives a reconnect and is re-sent on
    // the next connection — and that connection's own restore is already
    // replaying the set.
    if (!reconnected || mine !== generation) {
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
      settleAll(new Error("DeadSocket"));
      socket.disconnect();
    },
  };
}
