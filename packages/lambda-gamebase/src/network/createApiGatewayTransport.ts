import {
  DeleteConnectionCommand,
  GoneException,
  PostToConnectionCommand,
  type ApiGatewayManagementApiClient,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import type { GamebaseContext } from "../context.js";
import type { Transport } from "./transport.js";

export interface ApiGatewayTransportOptions {
  /** Explicit management client. */
  client?: ApiGatewayManagementApiClient;
  /** Supplies the shared management client when `client` is unset. */
  context?: GamebaseContext;
  logger?: Logger;
  /**
   * Aborts a `PostToConnection` after this many milliseconds. Without it a
   * single unresponsive connection can hold up a whole game tick.
   */
  sendTimeoutMillis?: number;
}

/** Sends JSON over an API Gateway WebSocket management endpoint. */
export function createApiGatewayTransport({
  client,
  context,
  logger = nullLogger,
  sendTimeoutMillis,
}: ApiGatewayTransportOptions = {}): Transport {
  function resolveClient(functionName: string): ApiGatewayManagementApiClient {
    const resolved = client ?? context?.getApiGatewayManagementClient();
    if (!resolved) {
      throw new Error(`${functionName} requires either client or context`);
    }
    return resolved;
  }

  function sendOptions(): { abortSignal?: AbortSignal } {
    return sendTimeoutMillis !== undefined && sendTimeoutMillis > 0
      ? { abortSignal: AbortSignal.timeout(sendTimeoutMillis) }
      : {};
  }

  return {
    send: async (connectionId, message) => {
      const resolved = resolveClient("reply");
      try {
        await resolved.send(
          new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: JSON.stringify(message),
          }),
          sendOptions(),
        );
        logger.debug("reply", { connectionId, response: message });
        return true;
      } catch (error) {
        if (isGoneException(error)) {
          logger.debug("connection is gone", { connectionId });
        } else {
          logger.error("cannot reply to", {
            connectionId,
            response: message,
            error,
          });
        }
        return false;
      }
    },
    drop: async (connectionId) => {
      const resolved = resolveClient("dropConnection");
      try {
        await resolved.send(
          new DeleteConnectionCommand({ ConnectionId: connectionId }),
        );
        return true;
      } catch (error) {
        // The goal is a disconnected client, so an already-gone
        // connection counts as success.
        return isGoneException(error);
      }
    },
  };
}

export function isGoneException(error: unknown): boolean {
  return (
    error instanceof GoneException ||
    (error instanceof Error && error.name === "GoneException")
  );
}
