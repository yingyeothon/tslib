import {
  ConnectionState,
  createNaiveSocket,
  type NaiveSocket,
  type TlsOptions,
} from "@yingyeothon/naive-socket";
import { redisAuth } from "./auth.js";

export interface RedisConnectionOptions {
  host: string;
  port?: number;
  /** ACL user name; sent as `AUTH <username> <password>` when set. */
  username?: string;
  password?: string;
  timeoutMillis?: number;
  /**
   * Timeout for the automatic `AUTH` sent after each (re)connect. It is the
   * first command on a fresh socket, so it also pays for the TCP and TLS
   * handshake; defaults to `max(timeoutMillis, 5000)`.
   */
  authTimeoutMillis?: number;
  /**
   * Wraps the connection in TLS. Unset means cleartext, so `AUTH` and every
   * command are readable on the wire — see `@yingyeothon/naive-socket`.
   */
  tls?: boolean | TlsOptions;
}

export interface RedisConnection {
  socket: NaiveSocket;
  timeoutMillis: number;
  /**
   * Pending automatic authentication of the current socket. Unset when no
   * password is configured, or after a failed `AUTH` tore the socket down
   * so the next command reconnects and authenticates again.
   */
  authenticated?: Promise<boolean>;
}

export function createRedisConnection({
  host,
  port = 6379,
  username,
  password,
  timeoutMillis = 1000,
  authTimeoutMillis = Math.max(timeoutMillis, 5000),
  tls,
}: RedisConnectionOptions): RedisConnection {
  const socket = createNaiveSocket({
    host,
    port,
    ...(tls !== undefined ? { tls } : {}),
    onConnectionStateChanged: ({ state }) => {
      if (password && state === ConnectionState.Connected) {
        // The previous socket's settled promise must not gate this AUTH:
        // `redisSend` would defer it to a microtask, and by then the socket
        // has already written the head of the queue — a user command,
        // which then answers `-NOAUTH` on a connection that never saw AUTH.
        connection.authenticated = undefined;
        const authenticated = redisAuth(connection, password, {
          username,
          timeoutMillis: authTimeoutMillis,
        });
        connection.authenticated = authenticated;
        authenticated
          .then((success) => {
            if (!success) {
              throw new Error("Invalid password");
            }
          })
          .catch((error: unknown) => {
            // An AUTH that outlived its socket (reconnect with pending
            // work) may time out after a newer one succeeded; it must not
            // tear down that healthy socket.
            if (connection.authenticated !== authenticated) {
              return;
            }
            // A socket that is connected but not authenticated answers
            // `-NOAUTH` to everything forever. Tear it down so the next
            // command reconnects and authenticates from scratch; a late
            // `AUTH` reply cannot be mistaken for that command's answer
            // either, because the receive buffer dies with the socket.
            connection.authenticated = undefined;
            socket.disconnect(
              error instanceof Error ? error : new Error(String(error)),
            );
          });
      }
    },
  });
  const connection: RedisConnection = {
    socket,
    timeoutMillis,
  };
  return connection;
}
