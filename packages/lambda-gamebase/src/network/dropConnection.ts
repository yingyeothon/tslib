import { DeleteConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { fakeConnectionId } from "./fakeConnectionId.js";
import {
  isGoneException,
  resolveManagementClient,
  type NetworkOptions,
} from "./reply.js";

/**
 * Forcefully closes one WebSocket connection. Returns true when the
 * connection is closed or already gone, false on any other failure.
 */
export async function dropConnection(
  connectionId: string,
  options: NetworkOptions = {},
): Promise<boolean> {
  if (connectionId === fakeConnectionId) {
    return true;
  }
  const client = resolveManagementClient("dropConnection", options);
  try {
    await client.send(
      new DeleteConnectionCommand({ ConnectionId: connectionId }),
    );
    return true;
  } catch (error) {
    // The goal is a disconnected client, so an already-gone connection
    // counts as success.
    return isGoneException(error);
  }
}
