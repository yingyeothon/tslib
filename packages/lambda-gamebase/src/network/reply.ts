import {
  GoneException,
  PostToConnectionCommand,
  type ApiGatewayManagementApiClient,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import type { GamebaseContext } from "../context.js";
import { fakeConnectionId } from "./fakeConnectionId.js";

export interface NetworkOptions {
  /** Explicit API Gateway management client. */
  client?: ApiGatewayManagementApiClient;
  /** Supplies the shared management client when `client` is unset. */
  context?: GamebaseContext;
  logger?: Logger;
}

export function resolveManagementClient(
  functionName: string,
  { client, context }: NetworkOptions,
): ApiGatewayManagementApiClient {
  const resolved = client ?? context?.getApiGatewayManagementClient();
  if (!resolved) {
    throw new Error(`${functionName} requires either client or context`);
  }
  return resolved;
}

/**
 * Sends a JSON response to one WebSocket connection. Returns false when
 * the message cannot be delivered — including when the client is already
 * gone (`GoneException`) — so callers can treat it as a disconnection.
 */
export async function reply<T extends { type: string }>(
  connectionId: string,
  response: T,
  options: NetworkOptions = {},
): Promise<boolean> {
  const logger = options.logger ?? nullLogger;
  if (connectionId === fakeConnectionId) {
    return true;
  }
  const client = resolveManagementClient("reply", options);
  try {
    await client.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify(response),
      }),
    );
    logger.debug("reply", { connectionId, response });
    return true;
  } catch (error) {
    if (isGoneException(error)) {
      logger.debug("connection is gone", { connectionId });
    } else {
      logger.error("cannot reply to", { connectionId, response, error });
    }
    return false;
  }
}

export function isGoneException(error: unknown): boolean {
  return (
    error instanceof GoneException ||
    (error instanceof Error && error.name === "GoneException")
  );
}
