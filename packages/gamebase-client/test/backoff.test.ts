import { describe, expect, it } from "vitest";
import { createBackoff } from "../src/index.js";

describe("createBackoff", () => {
  it("doubles from the initial delay up to the cap", () => {
    const backoff = createBackoff({
      initialMs: 500,
      maxMs: 3000,
      jitter: 0,
    });
    expect([
      backoff.next(),
      backoff.next(),
      backoff.next(),
      backoff.next(),
    ]).toEqual([500, 1000, 2000, 3000]);
    expect(backoff.attempts).toBe(4);
  });

  it("jitters within the configured fraction, on both sides", () => {
    const low = createBackoff({
      initialMs: 1000,
      jitter: 0.2,
      random: () => 0,
    });
    const high = createBackoff({
      initialMs: 1000,
      jitter: 0.2,
      random: () => 0.999999,
    });
    expect(low.next()).toBe(800);
    expect(high.next()).toBe(1200);
  });

  it("reset() starts the sequence over", () => {
    const backoff = createBackoff({ initialMs: 100, jitter: 0 });
    backoff.next();
    backoff.next();
    backoff.reset();
    expect(backoff.attempts).toBe(0);
    expect(backoff.next()).toBe(100);
  });

  it("returns undefined once maxAttempts is exhausted", () => {
    const backoff = createBackoff({
      initialMs: 100,
      jitter: 0,
      maxAttempts: 2,
    });
    expect(backoff.next()).toBe(100);
    expect(backoff.next()).toBe(200);
    expect(backoff.next()).toBeUndefined();
    expect(backoff.attempts).toBe(2);
  });
});
