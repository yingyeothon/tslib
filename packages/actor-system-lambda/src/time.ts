/**
 * Tracks the remaining lifetime of the current execution container
 * (for example, one AWS Lambda invocation).
 */
export interface Timeline {
  /** Epoch milliseconds of the last `reset` (or creation). */
  readonly epochMillis: number;
  /** The current timeout in milliseconds. */
  readonly timeoutMillis: number;
  /** Milliseconds elapsed since the last `reset` (or creation). */
  readonly passedMillis: number;
  /** Milliseconds left until the timeout is reached. */
  readonly remainMillis: number;
  /** True once the timeout has fully elapsed. */
  readonly over: boolean;
  /** Restart the timeline from now, optionally with a new timeout. */
  reset: (timeoutMillis?: number) => void;
}

const defaultTimeoutMillis = 5 * 1000;

/**
 * Create a `Timeline` that starts now, with a 5 second timeout unless
 * `timeoutMillis` says otherwise.
 */
export function createTimeline(timeoutMillis?: number): Timeline {
  let epochMillis = Date.now();
  let currentTimeoutMillis = timeoutMillis ?? defaultTimeoutMillis;
  return {
    get epochMillis() {
      return epochMillis;
    },
    get timeoutMillis() {
      return currentTimeoutMillis;
    },
    get passedMillis() {
      return Date.now() - epochMillis;
    },
    get remainMillis() {
      return epochMillis + currentTimeoutMillis - Date.now();
    },
    get over() {
      return epochMillis + currentTimeoutMillis - Date.now() <= 0;
    },
    reset(newTimeoutMillis?: number) {
      epochMillis = Date.now();
      if (newTimeoutMillis !== undefined) {
        currentTimeoutMillis = newTimeoutMillis;
      }
    },
  };
}
