/**
 * Message types this package enqueues on behalf of the connection
 * handlers. A game actor treats them as trusted bookkeeping — an `enter`
 * decides which member a connection is bound to — so a client must never
 * be able to produce one through `$default`; `handleMessages` refuses them.
 *
 * That closes one path, not the identity question. `handleConnect` still
 * takes `memberId` from the client's `x-member-id` header or query string
 * and only checks that it appears in the start event, so anyone who knows
 * another member's id can open a second connection as that member. Put an
 * authorizer in front of `$connect` and read the member id from its
 * claims; this package never sees a principal.
 */
export const reservedRequestTypes: readonly string[] = ["enter", "leave"];

export function isReservedRequestType(type: unknown): boolean {
  return typeof type === "string" && reservedRequestTypes.includes(type);
}
