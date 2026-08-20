import {
  GoneException,
  PostToConnectionCommand,
  type ApiGatewayManagementApiClient,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { ConsoleLogger, type Logger } from "@yingyeothon/logger";
import { getApiGatewayManagementClient } from "./apiGatewayManagementClient.js";
import { fakeConnectionId } from "./fakeConnectionId.js";

const defaultLogger = new ConsoleLogger(
  process.env.STAGE === "production" ? "info" : "debug",
);

export interface NetworkOptions {
  client?: ApiGatewayManagementApiClient;
  logger?: Logger;
}

/**
 * Sends a JSON response to one WebSocket connection. Returns false when
 * the message cannot be delivered — including when the client is already
 * gone (`GoneException`) — so callers can treat it as a disconnection.
 */
export async function reply<T extends { type: string }>(
  connectionId: string,
  response: T,
  { client, logger = defaultLogger }: NetworkOptions = {},
): Promise<boolean> {
  if (connectionId === fakeConnectionId) {
    return true;
  }
  try {
    await (client ?? getApiGatewayManagementClient()).send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify(response),
      }),
    );
    logger.debug({ connectionId, response }, "Reply");
    return true;
  } catch (error) {
    if (isGoneException(error)) {
      logger.debug({ connectionId }, "Connection is gone");
    } else {
      logger.error({ connectionId, response, error }, "Cannot reply to");
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
