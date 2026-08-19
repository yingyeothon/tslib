/**
 * A tiny cursor-based text scanner used to build custom `fulfill` functions.
 * Each `capture(endMark)` consumes the text up to (and including) the next
 * `endMark` and records the consumed text (without the mark).
 */
export class TextMatch {
  private readonly captured: string[] = [];
  private pos = 0;
  private error = false;

  constructor(private readonly buffer: string) {}

  public capture(endMark: string): this {
    if (this.error) {
      return this;
    }
    const start = this.pos;
    this.pos = this.buffer.indexOf(endMark, start);
    if (this.pos < 0) {
      this.error = true;
      return this;
    }
    this.captured.push(this.buffer.slice(start, this.pos));
    this.pos += endMark.length;
    if (this.pos > this.buffer.length) {
      this.error = true;
    }
    return this;
  }

  /** All captured fragments so far, as a copy. */
  public values(): string[] {
    return [...this.captured];
  }

  /**
   * The number of characters consumed by the whole chain,
   * or `-1` when any capture failed.
   */
  public evaluate(): number {
    return this.error ? -1 : this.pos;
  }
}

export type TextMatchChain = (m: TextMatch) => TextMatch;

/**
 * Lift a {@link TextMatchChain} into a `fulfill` function for
 * {@link NaiveSocket.send}: it returns the consumed length when the chain
 * matches, or `-1` to keep waiting for more data.
 */
export function withMatch(check: TextMatchChain): (buffer: string) => number {
  return (buffer) => check(new TextMatch(buffer)).evaluate();
}
