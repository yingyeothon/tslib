import type { Transport } from "@yingyeothon/lambda-gamebase";

export interface RecordedFrame {
  connectionIds: string[];
  message: unknown;
}

export interface RecordingTransport extends Transport {
  readonly frames: RecordedFrame[];
  readonly dropped: string[];
  /**
   * Sends and drops in one ordered list, as `send:<type>` and `drop:<id>`.
   * Two separate arrays cannot answer the question that actually matters —
   * did the result reach the party before their sockets were closed — and
   * that ordering is the whole reason `endDropDelayMillis` exists.
   */
  readonly events: string[];
}

/**
 * A `Transport` that records instead of sending.
 *
 * This is the seam the whole example turns on. `reply` and `broadcast` never
 * serialize — they hand the value to a transport — so swapping in one that
 * pushes to an array is enough to run the real game loop with no API Gateway
 * and no gateway process. In production the same slot takes
 * `createApiGatewayTransport` or `createRedisPubSubTransport`, and the game
 * loop above it does not change.
 */
export function createRecordingTransport(
  print: (line: string) => void = () => undefined,
): RecordingTransport {
  const frames: RecordedFrame[] = [];
  const dropped: string[] = [];
  const events: string[] = [];

  const record = (connectionIds: string[], message: unknown) => {
    frames.push({ connectionIds, message });
    events.push(`send:${(message as { type?: string }).type ?? "?"}`);
    print(`  -> ${connectionIds.join(",")}  ${JSON.stringify(message)}`);
    return Promise.resolve(true);
  };

  return {
    frames,
    dropped,
    events,
    send: (connectionId, message) => record([connectionId], message),
    // Implemented, so `broadcast` fans out in one call the way a gateway
    // transport does. Omitting it is legal and falls back to one `send` each.
    sendMany: (connectionIds, message) => record(connectionIds, message),
    drop: (connectionId) => {
      dropped.push(connectionId);
      events.push(`drop:${connectionId}`);
      print(`  xx ${connectionId} dropped`);
      return Promise.resolve(true);
    },
  };
}
