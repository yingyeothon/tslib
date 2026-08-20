import { nullLogger } from "@yingyeothon/logger";
import { reply, type NetworkOptions } from "./reply.js";

export interface RespondResult {
  [connectionId: string]: boolean;
}

/**
 * Sends one response to many connections in parallel and reports the
 * delivery result per connection id.
 */
export async function broadcast<T extends { type: string }>(
  connectionIds: string[],
  response: T,
  options: NetworkOptions = {},
): Promise<RespondResult> {
  const result = await Promise.all(
    connectionIds.map((connectionId) =>
      reply(connectionId, response, options).then((success) => ({
        [connectionId]: success,
      })),
    ),
  );
  const map = result.reduce<RespondResult>(
    (all, each) => Object.assign(all, each),
    {},
  );
  (options.logger ?? nullLogger).info("broadcast", {
    connectionIds,
    response,
    map,
  });
  return map;
}
