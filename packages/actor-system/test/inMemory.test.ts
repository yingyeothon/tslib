import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAwaiter, InMemoryLock, InMemoryQueue } from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("InMemoryQueue", () => {
  it("keeps FIFO order across push, peek, pop and size", async () => {
    const queue = new InMemoryQueue();
    expect(await queue.size("a")).toEqual(0);
    expect(await queue.pop("a")).toBeNull();
    expect(await queue.peek("a")).toBeNull();

    await queue.push("a", 1);
    await queue.push("a", 2);
    await queue.push("b", 10);

    expect(await queue.size("a")).toEqual(2);
    expect(await queue.peek("a")).toEqual(1);
    expect(await queue.pop("a")).toEqual(1);
    expect(await queue.pop("a")).toEqual(2);
    expect(await queue.pop("a")).toBeNull();
    expect(await queue.size("b")).toEqual(1);
  });

  it("flush drains everything at once and empties the queue", async () => {
    const queue = new InMemoryQueue();
    expect(await queue.flush("a")).toEqual([]);

    await queue.push("a", 1);
    await queue.push("a", 2);
    expect(await queue.flush("a")).toEqual([1, 2]);
    expect(await queue.size("a")).toEqual(0);
    expect(await queue.flush("a")).toEqual([]);
  });
});

describe("InMemoryLock", () => {
  it("is exclusive per actor id and reacquirable after release", async () => {
    const lock = new InMemoryLock();
    expect(await lock.tryAcquire("a")).toBe(true);
    expect(await lock.tryAcquire("a")).toBe(false);
    expect(await lock.tryAcquire("b")).toBe(true);

    expect(await lock.release("a")).toBe(true);
    expect(await lock.release("a")).toBe(false);
    expect(await lock.tryAcquire("a")).toBe(true);
  });
});

describe("InMemoryAwaiter", () => {
  it("resolves a waiting promise with true", async () => {
    const awaiter = new InMemoryAwaiter();
    const waiting = awaiter.wait("actor", "message", 0);
    await awaiter.resolve("actor", "message");
    expect(await waiting).toBe(true);
  });

  it("times out with false when nobody resolves", async () => {
    vi.useFakeTimers();
    const awaiter = new InMemoryAwaiter();
    const waiting = awaiter.wait("actor", "message", 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await waiting).toBe(false);
  });

  it("ignores a timeout that fires after resolution", async () => {
    vi.useFakeTimers();
    const awaiter = new InMemoryAwaiter();
    const waiting = awaiter.wait("actor", "message", 100);
    await awaiter.resolve("actor", "message");
    await vi.advanceTimersByTimeAsync(100);
    expect(await waiting).toBe(true);
  });

  it("ignores resolutions for unknown messages", async () => {
    const awaiter = new InMemoryAwaiter();
    await expect(awaiter.resolve("actor", "unknown")).resolves.toBeUndefined();
  });
});
