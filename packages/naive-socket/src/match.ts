/**
 * A tiny cursor-based text scanner used to build custom `fulfill` functions.
 * Each `capture(endMark)` consumes the text up to (and including) the next
 * `endMark` and records the consumed text (without the mark).
 */
export interface TextMatch {
  /** Consume up to (and including) the next `endMark`, recording the text before it. */
  capture: (endMark: string) => TextMatch;

  /** All captured fragments so far, as a copy. */
  values: () => string[];

  /**
   * The number of characters consumed by the whole chain,
   * or `-1` when any capture failed.
   */
  evaluate: () => number;
}

/** Create a {@link TextMatch} scanner over `buffer`. */
export function createTextMatch(buffer: string): TextMatch {
  const captured: string[] = [];
  let pos = 0;
  let error = false;

  const match: TextMatch = {
    capture: (endMark) => {
      if (error) {
        return match;
      }
      const start = pos;
      pos = buffer.indexOf(endMark, start);
      if (pos < 0) {
        error = true;
        return match;
      }
      captured.push(buffer.slice(start, pos));
      pos += endMark.length;
      if (pos > buffer.length) {
        error = true;
      }
      return match;
    },
    values: () => [...captured],
    evaluate: () => (error ? -1 : pos),
  };
  return match;
}

export type TextMatchChain = (m: TextMatch) => TextMatch;

/**
 * Lift a {@link TextMatchChain} into a `fulfill` function for
 * {@link NaiveSocket.send}: it returns the consumed length when the chain
 * matches, or `-1` to keep waiting for more data.
 */
export function withMatch(check: TextMatchChain): (buffer: string) => number {
  return (buffer) => check(createTextMatch(buffer)).evaluate();
}
