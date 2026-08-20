import { describe, expect, it, vi } from "vitest";
import {
  createEventBroker,
  type EventBroker,
  type EventListenable,
} from "../src/index.js";

interface BoxEventMap {
  data: string;
  error: Error;
  finish: void;
}

function createBox(): EventBroker<BoxEventMap> {
  return createEventBroker<BoxEventMap>();
}

async function call(
  broker: EventBroker<BoxEventMap>,
  error: Error | null,
  data: string | null,
): Promise<void> {
  if (error) {
    await broker.fire("error", error);
  }
  if (data) {
    await broker.fire("data", data);
  }
  await broker.fire("finish", undefined);
}

describe("createEventBroker", () => {
  it("dispatches data events but not error events on success", async () => {
    const onData = vi.fn();
    const onError = vi.fn();
    await call(
      createBox().on("data", onData).on("error", onError),
      null,
      "hello",
    );
    expect(onData).toHaveBeenCalledExactlyOnceWith("hello");
    expect(onError).not.toHaveBeenCalled();
  });

  it("dispatches error events but not data events on failure", async () => {
    const onData = vi.fn();
    const onError = vi.fn();
    const error = new Error("oops");
    await call(
      createBox().on("data", onData).on("error", onError),
      error,
      null,
    );
    expect(onData).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
  });

  it("calls many sync handlers in registration order", async () => {
    const calls: string[] = [];
    const record =
      (id: number) =>
      (value: unknown): void => {
        calls.push(`${id}:${String(value)}`);
      };
    await call(
      createBox()
        .on("data", record(0))
        .on("data", record(1))
        .on("data", record(2))
        .on("data", record(3))
        .on("finish", record(4)),
      null,
      "hello",
    );
    expect(calls).toEqual([
      "0:hello",
      "1:hello",
      "2:hello",
      "3:hello",
      "4:undefined",
    ]);
  });

  it("awaits each async handler before calling the next", async () => {
    const calls: number[] = [];
    const record = (id: number) => async (): Promise<void> => {
      await Promise.resolve();
      calls.push(id);
    };
    await call(
      createBox()
        .on("data", record(0))
        .on("data", record(1))
        .on("data", record(2))
        .on("finish", record(3)),
      null,
      "hello",
    );
    expect(calls).toEqual([0, 1, 2, 3]);
  });

  it("awaits handlers that resolve on a timer, using fake timers", async () => {
    vi.useFakeTimers();
    try {
      const calls: number[] = [];
      const record = (id: number) => () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            calls.push(id);
            resolve();
          }, 10),
        );
      const box = createBox().on("data", record(0)).on("data", record(1));
      const pending = box.fire("data", "hi");
      await vi.advanceTimersByTimeAsync(10);
      expect(calls).toEqual([0]);
      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toBe(true);
      expect(calls).toEqual([0, 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns false from fire when no handler is registered", async () => {
    await expect(createBox().fire("data", "hello")).resolves.toBe(false);
  });

  it("returns true from fire when at least one handler ran", async () => {
    const box = createBox().on("data", vi.fn());
    await expect(box.fire("data", "hello")).resolves.toBe(true);
  });

  it("removes a handler with off", async () => {
    const kept = vi.fn();
    const removed = vi.fn();
    const box = createBox().on("data", kept).on("data", removed);
    box.off("data", removed);
    await box.fire("data", "hello");
    expect(kept).toHaveBeenCalledExactlyOnceWith("hello");
    expect(removed).not.toHaveBeenCalled();
  });

  it("removes only the first matching registration with off", async () => {
    const handler = vi.fn();
    const box = createBox().on("data", handler).on("data", handler);
    box.off("data", handler);
    await box.fire("data", "hello");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("returns false from fire when every handler was removed", async () => {
    const handler = vi.fn();
    const box = createBox().on("data", handler);
    box.off("data", handler);
    await expect(box.fire("data", "hello")).resolves.toBe(false);
  });

  it("ignores off for an unknown handler or event", async () => {
    const handler = vi.fn();
    const box = createBox().on("data", handler);
    box.off("data", vi.fn());
    box.off("finish", vi.fn());
    await box.fire("data", "hello");
    expect(handler).toHaveBeenCalledExactlyOnceWith("hello");
  });

  it("calls a once handler exactly once", async () => {
    const onceHandler = vi.fn();
    const always = vi.fn();
    const box = createBox().once("data", onceHandler).on("data", always);
    await box.fire("data", "first");
    await box.fire("data", "second");
    expect(onceHandler).toHaveBeenCalledExactlyOnceWith("first");
    expect(always).toHaveBeenCalledTimes(2);
  });

  it("removes a once handler with off before it fires", async () => {
    const onceHandler = vi.fn();
    const box = createBox().once("data", onceHandler);
    box.off("data", onceHandler);
    await expect(box.fire("data", "hello")).resolves.toBe(false);
    expect(onceHandler).not.toHaveBeenCalled();
  });

  it("removes a once handler even when it throws", async () => {
    const onceHandler = vi.fn(() => {
      throw new Error("boom");
    });
    const box = createBox().once("data", onceHandler);
    await expect(box.fire("data", "first")).rejects.toThrow("boom");
    await expect(box.fire("data", "second")).resolves.toBe(false);
    expect(onceHandler).toHaveBeenCalledTimes(1);
  });

  it("keeps the current dispatch unchanged when a handler removes another", async () => {
    const calls: number[] = [];
    const second = (): void => {
      calls.push(1);
    };
    const box = createBox();
    const first = (): void => {
      calls.push(0);
      box.off("data", second);
    };
    box.on("data", first).on("data", second);
    await box.fire("data", "hello");
    expect(calls).toEqual([0, 1]);
    await box.fire("data", "again");
    expect(calls).toEqual([0, 1, 0]);
  });

  it("defers handlers added during dispatch to the next fire", async () => {
    const late = vi.fn();
    const box = createBox();
    box.on("data", () => {
      box.on("data", late);
    });
    await box.fire("data", "first");
    expect(late).not.toHaveBeenCalled();
    await box.fire("data", "second");
    expect(late).toHaveBeenCalledExactlyOnceWith("second");
  });

  it("rejects fire and skips remaining handlers when an async handler rejects", async () => {
    const after = vi.fn();
    const box = createBox()
      .on("data", () => Promise.reject(new Error("async boom")))
      .on("data", after);
    await expect(box.fire("data", "hello")).rejects.toThrow("async boom");
    expect(after).not.toHaveBeenCalled();
  });

  it("rejects fire when a sync handler throws", async () => {
    const box = createBox().on("data", () => {
      throw new Error("sync boom");
    });
    await expect(box.fire("data", "hello")).rejects.toThrow("sync boom");
  });

  it("keeps events of different names independent", async () => {
    const onData = vi.fn();
    const onFinish = vi.fn();
    const box = createBox().on("data", onData).on("finish", onFinish);
    await box.fire("data", "hello");
    expect(onData).toHaveBeenCalledExactlyOnceWith("hello");
    expect(onFinish).not.toHaveBeenCalled();
  });

  it("supports chaining through the EventListenable interface", async () => {
    const box = createBox();
    const listenable: EventListenable<BoxEventMap> = box;
    const handler = vi.fn();
    const result = listenable
      .on("data", handler)
      .once("finish", handler)
      .off("error", handler);
    expect(result).toBe(box);
    await call(box, null, "hello");
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
