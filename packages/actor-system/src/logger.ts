/**
 * Minimal structural logger used by the actor system.
 *
 * It is structurally compatible with `Logger` from `@yingyeothon/logger`,
 * so any logger from that package can be passed in directly, but this
 * package does not depend on it.
 */
export interface ActorSystemLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** A logger that discards everything. Used when no logger is configured. */
export const noopLogger: ActorSystemLogger = {
  debug: () => undefined,
  info: () => undefined,
  error: () => undefined,
};
