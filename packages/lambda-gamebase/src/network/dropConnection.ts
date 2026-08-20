import { DeleteConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { getApiGatewayManagementClient } from "./apiGatewayManagementClient.js";
import { fakeConnectionId } from "./fakeConnectionId.js";
import { isGoneException, type NetworkOptions } from "./reply.js";

/**
 * Forcefully closes one WebSocket connection. Returns true when the
 * connection is closed or already gone, false on any other failure.
 */
export async function dropConnection(
  connectionId: string,
  { client }: NetworkOptions = {},
): Promise<boolean> {
  if (connectionId === fakeConnectionId) {
    return true;
  }
  try {
    await (client ?? getApiGatewayManagementClient()).send(
      new DeleteConnectionCommand({ ConnectionId: connectionId }),
    );
    return true;
  } catch (error) {
    // The goal is a disconnected client, so an already-gone connection
    // counts as success.
    return isGoneException(error);
  }
}
