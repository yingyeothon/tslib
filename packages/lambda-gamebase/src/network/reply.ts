import { fakeConnectionId } from "./fakeConnectionId.js";
import { resolveTransport } from "./resolveTransport.js";
import type { NetworkOptions } from "./transport.js";

/**
 * Sends one response to one client connection through the resolved
 * transport. Returns false when the message cannot be delivered —
 * including when the client is already gone — so callers can treat it as
 * a disconnection.
 *
 * It stays `async` so an unresolvable transport surfaces as a rejection
 * rather than a synchronous throw.
 */
export async function reply<T extends { type: string }>(
  connectionId: string,
  response: T,
  options: NetworkOptions = {},
): Promise<boolean> {
  if (connectionId === fakeConnectionId) {
    return true;
  }
  return resolveTransport("reply", options).send(connectionId, response);
}
