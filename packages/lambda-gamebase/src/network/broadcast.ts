import { nullLogger } from "@yingyeothon/logger";
import { fakeConnectionId } from "./fakeConnectionId.js";
import { reply } from "./reply.js";
import { resolveTransport } from "./resolveTransport.js";
import type { NetworkOptions } from "./transport.js";

export interface RespondResult {
  [connectionId: string]: boolean;
}

/**
 * Sends one response to many connections and reports the delivery result
 * per connection id.
 *
 * A transport that offers `sendMany` gets one call for the whole set;
 * otherwise every connection is sent to in parallel. The result shape is
 * the same either way, so callers do not have to know which happened.
 */
export async function broadcast<T extends { type: string }>(
  connectionIds: string[],
  response: T,
  options: NetworkOptions = {},
): Promise<RespondResult> {
  const logger = options.logger ?? nullLogger;
  const map: RespondResult = {};

  // Locally simulated members have no socket behind them, so they are
  // "delivered" without reaching a transport at all.
  const real = connectionIds.filter((connectionId) => {
    if (connectionId === fakeConnectionId) {
      map[connectionId] = true;
      return false;
    }
    return true;
  });

  const sendMany =
    real.length > 0
      ? resolveTransport("broadcast", options).sendMany
      : undefined;
  if (sendMany) {
    const delivered = await sendMany(real, response);
    for (const connectionId of real) {
      map[connectionId] = delivered;
    }
  } else {
    await Promise.all(
      real.map(async (connectionId) => {
        map[connectionId] = await reply(connectionId, response, options);
      }),
    );
  }

  const values = Object.values(map);
  // Never the ids or the payload: a game message can carry player state,
  // and at a fixed tick this line runs several times a second.
  logger.debug("broadcast", {
    type: response.type,
    total: values.length,
    delivered: values.filter(Boolean).length,
  });
  return map;
}
