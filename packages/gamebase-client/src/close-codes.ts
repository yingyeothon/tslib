export type GatewayChannelKind = "lobby" | "q";

/** Application close codes the gateway uses (4000-4004). */
export const GatewayCloseCode = {
  /** A newer socket of the same user replaced this one. Do not reconnect. */
  replaced: 4000,
  /** q only: the actor stopped consuming; the run is aborted, not finished. */
  aborted: 4001,
  /** No pong within the idle window. */
  idle: 4002,
  /** Too many refused messages on one socket; a client bug. */
  policy: 4003,
  /** The channel expired or was disabled. */
  channelGone: 4004,
} as const;

export type CloseDispositionKind =
  "reconnect" | "stop" | "aborted" | "finished" | "clientBug";

export interface CloseDisposition {
  kind: CloseDispositionKind;
  reason: string;
}

/**
 * Maps a close code to what the client should do. Every code the gateway
 * documents is listed; anything else is treated as a transient network
 * failure and retried with backoff.
 */
export function classifyClose(
  code: number,
  kind: GatewayChannelKind,
): CloseDisposition {
  switch (code) {
    case GatewayCloseCode.replaced:
      return { kind: "stop", reason: "replaced by a newer connection" };
    case GatewayCloseCode.aborted:
      return kind === "q"
        ? { kind: "aborted", reason: "the game actor stopped responding" }
        : { kind: "stop", reason: "aborted" };
    case GatewayCloseCode.idle:
      return { kind: "reconnect", reason: "idle timeout" };
    case GatewayCloseCode.policy:
      return { kind: "clientBug", reason: "too many refused messages" };
    case GatewayCloseCode.channelGone:
      return { kind: "stop", reason: "channel expired or disabled" };
    case 1000:
      return kind === "q"
        ? { kind: "finished", reason: "the game dropped the connection" }
        : { kind: "stop", reason: "closed normally" };
    case 1001:
      return { kind: "reconnect", reason: "gateway restarting" };
    case 1003:
      return { kind: "clientBug", reason: "binary frame sent" };
    case 1009:
      return { kind: "clientBug", reason: "frame too large" };
    case 1011:
      return { kind: "reconnect", reason: "gateway failed to enter the game" };
    default:
      return { kind: "reconnect", reason: `connection lost (${code})` };
  }
}
