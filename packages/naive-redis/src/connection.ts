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
   * Wraps the connection in TLS. Unset means cleartext, so `AUTH` and every
   * command are readable on the wire — see `@yingyeothon/naive-socket`.
   */
  tls?: boolean | TlsOptions;
}

export interface RedisConnection {
  socket: NaiveSocket;
  timeoutMillis: number;
  authenticated?: Promise<boolean>;
}

export function createRedisConnection({
  host,
  port = 6379,
  username,
  password,
  timeoutMillis = 1000,
  tls,
}: RedisConnectionOptions): RedisConnection {
  const socket = createNaiveSocket({
    host,
    port,
    ...(tls !== undefined ? { tls } : {}),
    onConnectionStateChanged: ({ state }) => {
      if (password && state === ConnectionState.Connected) {
        const authenticated = redisAuth(connection, password, { username });
        // Keep a failed authentication from surfacing as an unhandled
        // rejection; callers still observe it through `redisSend`.
        authenticated.catch(() => undefined);
        connection.authenticated = authenticated;
      }
    },
  });
  const connection: RedisConnection = {
    socket,
    timeoutMillis,
  };
  return connection;
}
