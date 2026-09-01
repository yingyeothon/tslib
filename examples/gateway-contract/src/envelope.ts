import { AwaitPolicy, type UserMessage } from "@yingyeothon/actor-system";

/**
 * The key the actor drains, byte for byte.
 *
 * `createRedisQueue` writes `keyPrefix + actorId` and nothing else.
 * `createRedisSubsystem` appends a `queue:` segment to the prefix it is given;
 * `createActorSubsystem` in `lambda-gamebase` and `handleConnect` do **not**.
 * A gateway that copies the subsystem's layout pushes into a key nobody drains,
 * and nothing anywhere reports it.
 */
export const queueKeyFor = (queueKeyPrefix: string, gameId: string): string =>
  `${queueKeyPrefix}${gameId}`;

/** The channel the actor publishes on, which must be subscribed first. */
export const outboundChannelFor = (
  channelPrefix: string,
  gameId: string,
): string => `${channelPrefix}${gameId}`;

/**
 * Wraps a game message the way `enqueue` does.
 *
 * A pushed value is a `UserMessage<T>`, not a bare payload. Push the payload
 * on its own and `poll()` hands the game an array of `undefined` items — no
 * exception, no log line, just a game that never sees an input.
 *
 * `awaitPolicy` is a **numeric** enum, and `AwaitPolicy.Forget` is `0`, which
 * is what a gateway wants: it pushes and moves on rather than waiting for the
 * actor to finish.
 */
export function buildUserMessage<T>(item: T): UserMessage<T> {
  return {
    messageId: crypto.randomUUID(),
    awaitPolicy: AwaitPolicy.Forget,
    awaitTimeoutMillis: 0,
    item,
  };
}
