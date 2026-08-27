export interface BackoffOptions {
  /** Delay before the first retry. Default 500 ms. */
  initialMs?: number;
  /** Upper bound on any delay. Default 15000 ms. */
  maxMs?: number;
  /** Multiplier applied per attempt. Default 2. */
  factor?: number;
  /** Fraction of the delay randomised on both sides. Default 0.2. */
  jitter?: number;
  /** Give up after this many consecutive attempts. Default unbounded. */
  maxAttempts?: number;
  /** Random source in [0, 1); injectable for deterministic tests. */
  random?: () => number;
}

export interface Backoff {
  /** Consecutive attempts since the last `reset()`. */
  readonly attempts: number;
  /** Next delay in ms, or `undefined` when `maxAttempts` is exhausted. */
  next(): number | undefined;
  reset(): void;
}

export function createBackoff(options: BackoffOptions = {}): Backoff {
  const {
    initialMs = 500,
    maxMs = 15000,
    factor = 2,
    jitter = 0.2,
    maxAttempts = Number.POSITIVE_INFINITY,
    random = Math.random,
  } = options;
  let attempts = 0;
  return {
    get attempts() {
      return attempts;
    },
    next() {
      if (attempts >= maxAttempts) {
        return undefined;
      }
      const base = Math.min(maxMs, initialMs * factor ** attempts);
      attempts += 1;
      const spread = base * jitter;
      return Math.round(base - spread + random() * spread * 2);
    },
    reset() {
      attempts = 0;
    },
  };
}
