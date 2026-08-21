import { fakeConnectionId } from "./fakeConnectionId.js";
import { resolveTransport } from "./resolveTransport.js";
import type { NetworkOptions } from "./transport.js";

/**
 * Forcefully closes one client connection through the resolved transport.
 * Returns true when the connection is closed or already gone, false on any
 * other failure.
 *
 * It stays `async` so an unresolvable transport surfaces as a rejection
 * rather than a synchronous throw.
 */
export async function dropConnection(
  connectionId: string,
  options: NetworkOptions = {},
): Promise<boolean> {
  if (connectionId === fakeConnectionId) {
    return true;
  }
  return resolveTransport("dropConnection", options).drop(connectionId);
}
