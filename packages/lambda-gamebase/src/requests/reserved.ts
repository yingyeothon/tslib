/**
 * Message types this package enqueues on behalf of the connection
 * handlers. A game actor treats them as trusted bookkeeping — an `enter`
 * decides which member a connection is bound to — so a client must never
 * be able to produce one through `$default`; `handleMessages` refuses them.
 *
 * That closes one path, not the identity question. By default
 * `handleConnect` still takes `memberId` from the client's `x-member-id`
 * header or query string and only checks that it appears in the start
 * event, so anyone who knows another member's id can open a second
 * connection as that member. Pass `handleConnect` a `resolveMemberId` that
 * reads a REQUEST authorizer's context to close that.
 *
 * Two things stay open even then, because neither is an identity question:
 * a member may hold several connections at once, and a connection that a
 * later `enter` superseded keeps its `connectionId` -> `gameId` mapping
 * until it disconnects or the mapping expires.
 */
export const reservedRequestTypes: readonly string[] = ["enter", "leave"];

export function isReservedRequestType(type: unknown): boolean {
  return typeof type === "string" && reservedRequestTypes.includes(type);
}
