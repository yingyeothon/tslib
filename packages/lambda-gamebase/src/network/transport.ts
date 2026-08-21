import type { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
import type { Logger } from "@yingyeothon/logger";
import type { GamebaseContext } from "../context.js";

/**
 * Delivers game messages to one client connection and closes it.
 *
 * Encoding belongs to the implementation: `reply` and `broadcast` hand
 * over the value the game produced and never serialize it themselves, so
 * a transport is free to use JSON, a binary codec, or an envelope of its
 * own. `@yingyeothon/lambda-gamebase` ships an API Gateway implementation
 * and a Redis pub/sub one; a WebSocket gateway of your own can supply a
 * third without changing the game loop.
 */
export interface Transport {
  /** Returns false when the message could not be delivered. */
  send: (connectionId: string, message: unknown) => Promise<boolean>;
  /** Returns true when the connection is closed or already gone. */
  drop: (connectionId: string) => Promise<boolean>;
}

export interface NetworkOptions {
  /** Explicit transport. Takes precedence over `client` and `context`. */
  transport?: Transport;
  /** Explicit API Gateway management client for the default transport. */
  client?: ApiGatewayManagementApiClient;
  /** Supplies the shared management client when `client` is unset. */
  context?: GamebaseContext;
  logger?: Logger;
  /**
   * Aborts a single delivery after this many milliseconds, so one
   * unresponsive connection cannot stall a game tick. Used by the default
   * API Gateway transport.
   */
  sendTimeoutMillis?: number;
}
