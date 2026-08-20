import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setupBaseGameContext,
  sleep,
  Ticker,
  TimeDelta,
} from "../src/index.js";

describe("sleep", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves after the given milliseconds", async () => {
    const done = vi.fn();
    const promise = sleep(500).then(done);

    await vi.advanceTimersByTimeAsync(499);
    expect(done).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(done).toHaveBeenCalledOnce();
  });
});

describe("Ticker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ages by whole seconds and dies after aliveMillis", async () => {
    const ticker = new Ticker("stage", 3000);
    expect(ticker.age).toBe(0);
    expect(ticker.isAlive()).toBe(true);

    await vi.advanceTimersByTimeAsync(2500);
    expect(ticker.age).toBe(2);
    expect(ticker.isAlive()).toBe(true);

    await vi.advanceTimersByTimeAsync(500);
    expect(ticker.isAlive()).toBe(false);
  });

  it("notifies only when the age changes", async () => {
    const ticker = new Ticker("running", 10_000);
    const onChanged = vi.fn().mockResolvedValue(undefined);

    await ticker.checkAgeChanged(onChanged);
    expect(onChanged).toHaveBeenCalledWith("running", 0);

    await ticker.checkAgeChanged(onChanged);
    expect(onChanged).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    await ticker.checkAgeChanged(onChanged);
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenLastCalledWith("running", 1);
  });
});

describe("TimeDelta", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns elapsed seconds between calls", async () => {
    const timeDelta = new TimeDelta();
    await vi.advanceTimersByTimeAsync(250);
    expect(timeDelta.getDelta()).toBeCloseTo(0.25);

    await vi.advanceTimersByTimeAsync(1500);
    expect(timeDelta.getDelta()).toBeCloseTo(1.5);
    expect(timeDelta.getDelta()).toBe(0);
  });
});

describe("setupBaseGameContext", () => {
  it("splits members into users and observers", () => {
    const context = setupBaseGameContext([
      { memberId: "m1", name: "one", email: "one@yyt.life" },
      { memberId: "m2", name: "two", email: "two@yyt.life", observer: true },
      { memberId: "m3", name: "three", email: "three@yyt.life" },
    ]);
    expect(context.users).toEqual([
      { connectionId: "", load: false, memberId: "m1" },
      { connectionId: "", load: false, memberId: "m3" },
    ]);
    expect(context.observers).toEqual([{ connectionId: "", memberId: "m2" }]);
    expect(context.connectedUsers).toEqual({});
  });
});
