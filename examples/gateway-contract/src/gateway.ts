import type { GatewayCommand } from "@yingyeothon/lambda-gamebase";

export interface DeliveredFrame {
  connectionIds: string[];
  message: unknown;
}

export interface GatewayFanOut {
  delivered: DeliveredFrame[];
  closed: string[];
}

/**
 * The half of the bridge a gateway written in any language must implement.
 *
 * **There are two `send` shapes and `op` does not tell them apart.** `reply`
 * publishes `connectionId`; `broadcast` publishes `connectionIds` so the
 * gateway does the fan-out it is already positioned to do — at eight players
 * and a fixed tick that is one publish per tick instead of eight. A gateway
 * that reads `command.connectionId` alone gets `undefined` for every broadcast
 * and drops the frame, with no error anywhere.
 */
export function applyGatewayCommand(
  command: GatewayCommand,
  into: GatewayFanOut,
): void {
  if (command.op === "drop") {
    into.closed.push(command.connectionId);
    return;
  }
  // Branch on the field, not on `op`. This is the whole point.
  const connectionIds = command.connectionIds ?? [command.connectionId];
  into.delivered.push({ connectionIds, message: command.message });
}

/** Parses a published frame, refusing anything that is not a command. */
export function parseGatewayCommand(payload: string): GatewayCommand | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const op = (parsed as { op?: unknown }).op;
  return op === "send" || op === "drop" ? (parsed as GatewayCommand) : null;
}
