import { createApiGatewayTransport } from "./createApiGatewayTransport.js";
import type { NetworkOptions, Transport } from "./transport.js";

/**
 * Picks the transport a network call should use: an explicit one, or the
 * API Gateway transport built from the given client or gamebase context.
 */
export function resolveTransport(
  functionName: string,
  { transport, client, context, logger, sendTimeoutMillis }: NetworkOptions,
): Transport {
  if (transport) {
    return transport;
  }
  if (!client && !context) {
    throw new Error(
      `${functionName} requires either transport, client, or context`,
    );
  }
  return createApiGatewayTransport({
    client,
    context,
    logger,
    sendTimeoutMillis,
  });
}
