import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Timeline } from "../src/index.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Timeline", () => {
  it("starts with a 5 second timeout", () => {
    const timeline = new Timeline();
    expect(timeline.timeoutMillis).toEqual(5000);
    expect(timeline.passedMillis).toEqual(0);
    expect(timeline.remainMillis).toEqual(5000);
    expect(timeline.over).toBe(false);
  });

  it("tracks passed and remaining time", () => {
    const timeline = new Timeline();
    timeline.reset(1000);

    vi.advanceTimersByTime(400);
    expect(timeline.passedMillis).toEqual(400);
    expect(timeline.remainMillis).toEqual(600);
    expect(timeline.over).toBe(false);

    vi.advanceTimersByTime(600);
    expect(timeline.remainMillis).toEqual(0);
    expect(timeline.over).toBe(true);
  });

  it("keeps the previous timeout when reset without an argument", () => {
    const timeline = new Timeline();
    timeline.reset(1000);
    vi.advanceTimersByTime(1500);
    expect(timeline.over).toBe(true);

    timeline.reset();
    expect(timeline.timeoutMillis).toEqual(1000);
    expect(timeline.passedMillis).toEqual(0);
    expect(timeline.remainMillis).toEqual(1000);
    expect(timeline.over).toBe(false);
  });
});
