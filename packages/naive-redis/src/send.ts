import {
  createTextMatch,
  withMatch,
  type TextMatchChain,
} from "@yingyeothon/naive-socket";
import type { RedisConnection } from "./connection.js";

const newline = "\r\n";

export interface RedisSendOptions<T> {
  connection: RedisConnection;
  commands: string[];
  match: TextMatchChain;
  transform: (result: string[]) => T;
  urgent?: boolean;
  /** Overrides the connection's `timeoutMillis` for this request only. */
  timeoutMillis?: number;
  /**
   * Whether a `-NOAUTH`/`-WRONGPASS` reply drops the socket and retries
   * once on a fresh connection. Default true; `AUTH` itself turns it off,
   * because its failure is handled by the connection.
   */
  recoverAuthentication?: boolean;
}

/**
 * Redis answers these when the socket is connected but not (correctly)
 * authenticated. They never resolve on their own: the same socket keeps
 * answering them for every later command.
 */
function isAuthenticationError(response: string): boolean {
  return response.startsWith("-NOAUTH") || response.startsWith("-WRONGPASS");
}

export function redisSend<T>({
  connection,
  commands,
  match,
  transform,
  urgent,
  timeoutMillis = connection.timeoutMillis,
  recoverAuthentication = true,
}: RedisSendOptions<T>): Promise<T> {
  async function doSend(retryOnAuthError: boolean): Promise<T> {
    const response = await connection.socket.send({
      message: commands.join(newline) + newline,
      fulfill: withMatch(match),
      timeoutMillis,
      urgent,
    });
    if (recoverAuthentication && isAuthenticationError(response)) {
      // The socket is poisoned; drop it so the next command reconnects and
      // the connection authenticates again. Retry once only when there are
      // credentials to retry with — `authenticated` is set whenever the
      // connection was configured with a password.
      const hasCredentials = connection.authenticated !== undefined;
      connection.authenticated = undefined;
      // Other commands queued on this socket die with this reason (the
      // server's reply carries no credential); only this one is retried.
      connection.socket.disconnect(new Error(response.trim()));
      if (hasCredentials && retryOnAuthError) {
        return doSend(false);
      }
    }
    return transform(match(createTextMatch(response)).values());
  }
  return connection.authenticated
    ? connection.authenticated.then((success) => {
        if (!success) {
          throw new Error("Invalid password");
        }
        return doSend(true);
      })
    : doSend(true);
}
