/**
 * Tracks the remaining lifetime of the current execution container
 * (for example, one AWS Lambda invocation).
 */
export class Timeline {
  public epochMillis: number = Date.now();
  public timeoutMillis: number = 5 * 1000;

  /** Restart the timeline from now, optionally with a new timeout. */
  public reset(timeoutMillis?: number): void {
    this.epochMillis = Date.now();
    if (timeoutMillis !== undefined) {
      this.timeoutMillis = timeoutMillis;
    }
  }

  /** Milliseconds elapsed since the last `reset` (or construction). */
  public get passedMillis(): number {
    return Date.now() - this.epochMillis;
  }

  /** Milliseconds left until the timeout is reached. */
  public get remainMillis(): number {
    return this.epochMillis + this.timeoutMillis - Date.now();
  }

  /** True once the timeout has fully elapsed. */
  public get over(): boolean {
    return this.remainMillis <= 0;
  }
}

/**
 * The process-wide timeline, reset by `handleActorLambdaEvent` at the start
 * of each invocation so user code can check the remaining lifetime.
 */
export const globalTimeline = new Timeline();
