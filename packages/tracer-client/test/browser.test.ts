import { describe, expect, it, vi } from "vitest";
import {
  attachBrowserHooks,
  captureCanvasScreenshot,
  createTracerClient,
} from "../src/index.js";
import type { TracerEventTarget } from "../src/index.js";
import { createFakeFetch, fixtureDsn, settle } from "./support.js";

/** A DOM-shaped event target the test dispatches on. */
function createTarget(): TracerEventTarget & {
  dispatch(type: string, event?: unknown): void;
  count(): number;
} {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const target = {
    visibilityState: "visible",
    addEventListener(type: string, listener: (event: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: (event: unknown) => void) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type: string, event: unknown = {}) {
      for (const l of listeners.get(type) ?? []) l(event);
    },
    count() {
      let n = 0;
      for (const set of listeners.values()) n += set.size;
      return n;
    },
  };
  return target;
}

function setup() {
  const fake = createFakeFetch([], { status: 0, type: "opaque" });
  const client = createTracerClient({
    dsn: fixtureDsn,
    fetch: fake.fetch,
    corsSafe: true,
  });
  return { fake, client };
}

describe("attachBrowserHooks", () => {
  it("turns uncaught errors and rejections into breadcrumbs", async () => {
    const { fake, client } = setup();
    const target = createTarget();
    const document = createTarget();
    attachBrowserHooks(client, { target, document });
    target.dispatch("error", {
      error: new TypeError("x is undefined"),
      message: "Uncaught TypeError: x is undefined",
      filename: "https://game.example/main.js",
      lineno: 3,
      colno: 9,
    });
    target.dispatch("error", { message: "Script error." });
    target.dispatch("unhandledrejection", { reason: "nope" });
    target.dispatch("unhandledrejection", {});
    await client.report("r");
    await client.flush();
    const crumbs = (
      fake.sent[0]!.envelope.items[0]!.json["breadcrumbs"] as {
        values: Record<string, unknown>[];
      }
    ).values;
    expect(
      crumbs.map((b) => [b["category"], b["level"], b["message"]]),
    ).toEqual([
      ["error", "error", "TypeError: x is undefined"],
      ["error", "error", "Script error."],
      ["unhandledrejection", "error", "nope"],
      ["unhandledrejection", "error", "rejected"],
    ]);
    expect(crumbs[0]!["data"]).toEqual({
      filename: "https://game.example/main.js",
      lineno: 3,
      colno: 9,
    });
  });

  it("reports errors when asked, up to maxReports", async () => {
    const { fake, client } = setup();
    const target = createTarget();
    attachBrowserHooks(client, {
      target,
      document: createTarget(),
      reportErrors: true,
      maxReports: 2,
    });
    for (let i = 0; i < 3; i++) {
      target.dispatch("error", { error: new Error(`e${i}`) });
    }
    await client.flush();
    await settle();
    const events = fake.sent.filter(
      (s) => s.envelope.items[0]!.header["type"] === "event",
    );
    expect(events).toHaveLength(2);
    expect(events[0]!.envelope.items[0]!.json["level"]).toBe("error");
    expect(
      (
        events[0]!.envelope.items[0]!.json["exception"] as {
          values: { value: string }[];
        }
      ).values[0]!.value,
    ).toBe("e0");
  });

  it("flushes when the page is hidden or unloads", async () => {
    const { fake, client } = setup();
    const target = createTarget();
    const document = createTarget();
    attachBrowserHooks(client, { target, document });
    client.log("info", "one");
    document.dispatch("visibilitychange");
    await settle();
    expect(fake.sent).toHaveLength(0);
    document.visibilityState = "hidden";
    document.dispatch("visibilitychange");
    await settle();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.init.keepalive).toBe(true);
    client.log("info", "two");
    target.dispatch("pagehide");
    await settle();
    expect(fake.sent).toHaveLength(2);
  });

  it("detaches every listener, and honours errors/flushOnHide: false", () => {
    const { client } = setup();
    const target = createTarget();
    const document = createTarget();
    const detach = attachBrowserHooks(client, { target, document });
    expect(target.count() + document.count()).toBe(4);
    detach();
    detach();
    expect(target.count() + document.count()).toBe(0);
    attachBrowserHooks(client, {
      target,
      document,
      errors: false,
      flushOnHide: false,
    });
    expect(target.count() + document.count()).toBe(0);
  });

  it("swallows a failure inside its own listener", () => {
    const target = createTarget();
    const client = {
      breadcrumb: () => {
        throw new Error("boom");
      },
    } as never;
    attachBrowserHooks(client, { target, document: createTarget() });
    expect(() => target.dispatch("error", {})).not.toThrow();
  });

  it("uses globalThis and its document by default, and is a no-op without them", () => {
    const { client } = setup();
    expect(() => attachBrowserHooks(client)()).not.toThrow();
    const target = createTarget();
    const document = createTarget();
    vi.stubGlobal("addEventListener", (t: string, l: (e: unknown) => void) =>
      target.addEventListener(t, l),
    );
    vi.stubGlobal("removeEventListener", (t: string, l: (e: unknown) => void) =>
      target.removeEventListener(t, l),
    );
    vi.stubGlobal("document", document);
    try {
      const detach = attachBrowserHooks(client);
      expect(target.count()).toBe(3);
      expect(document.count()).toBe(1);
      detach();
      expect(target.count() + document.count()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const blob = (bytes: Uint8Array) => ({
  arrayBuffer: () => Promise.resolve(bytes.slice().buffer),
});

describe("captureCanvasScreenshot", () => {
  it("reads an HTMLCanvasElement through toBlob", async () => {
    let asked: string | undefined;
    const canvas = {
      toBlob(cb: (b: ReturnType<typeof blob> | null) => void, type?: string) {
        asked = type;
        cb(blob(png));
      },
    };
    expect(await captureCanvasScreenshot(canvas)).toEqual(png);
    expect(asked).toBe("image/png");
  });

  it("reads an OffscreenCanvas through convertToBlob", async () => {
    const canvas = {
      convertToBlob: (o?: { type?: string }) =>
        Promise.resolve(blob(o?.type === "image/png" ? png : new Uint8Array())),
    };
    expect(await captureCanvasScreenshot(canvas)).toEqual(png);
  });

  it("is undefined for a tainted, empty or unknown canvas", async () => {
    expect(
      await captureCanvasScreenshot({
        toBlob() {
          throw new Error("SecurityError");
        },
      }),
    ).toBeUndefined();
    expect(
      await captureCanvasScreenshot({ toBlob: (cb) => cb(null) }),
    ).toBeUndefined();
    expect(
      await captureCanvasScreenshot({
        convertToBlob: () => Promise.resolve(blob(new Uint8Array())),
      }),
    ).toBeUndefined();
    expect(await captureCanvasScreenshot({})).toBeUndefined();
  });
});

describe("unloading", () => {
  it("starts every small queued envelope at once behind a large one in flight", async () => {
    const fake = createFakeFetch([{ hang: true }], {
      status: 0,
      type: "opaque",
    });
    const client = createTracerClient({
      dsn: fixtureDsn,
      fetch: fake.fetch,
      corsSafe: true,
    });
    const target = createTarget();
    attachBrowserHooks(client, { target, document: createTarget() });
    const id = await client.report("big", {
      screenshot: new Uint8Array(100 * 1024),
    });
    await settle();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.init.keepalive).toBeUndefined();
    client.log("info", "after");
    await client.feedback("note", { eventId: id });
    target.dispatch("pagehide");
    await settle();
    expect(fake.sent).toHaveLength(3);
    expect(fake.sent.slice(1).map((s) => s.init.keepalive)).toEqual([
      true,
      true,
    ]);
    expect(client.stats.queued).toBe(0);
  });

  it("keeps keepalive to bodies of at most 60 KiB", async () => {
    const fake = createFakeFetch([], { status: 0, type: "opaque" });
    const client = createTracerClient({
      dsn: fixtureDsn,
      fetch: fake.fetch,
      corsSafe: true,
    });
    await client.report("a", {
      attachments: [{ filename: "a", data: new Uint8Array(58 * 1024) }],
    });
    await client.flush();
    await client.report("b", {
      attachments: [{ filename: "b", data: new Uint8Array(61 * 1024) }],
    });
    await client.flush();
    expect(fake.sent[0]!.body.length).toBeLessThanOrEqual(60 * 1024);
    expect(fake.sent.map((s) => s.init.keepalive)).toEqual([true, undefined]);
  });
});

describe("defensive edges", () => {
  it("strips the query from an error's filename", async () => {
    const { fake, client } = setup();
    const target = createTarget();
    attachBrowserHooks(client, { target, document: createTarget() });
    target.dispatch("error", {
      message: "m",
      filename: "https://cdn.example/app.js?token=SECRET-1#x",
    });
    await client.report("r");
    await client.flush();
    const crumb = (
      fake.sent[0]!.envelope.items[0]!.json["breadcrumbs"] as {
        values: { data: Record<string, unknown> }[];
      }
    ).values[0]!;
    expect(crumb.data["filename"]).toBe("https://cdn.example/app.js");
    expect(new TextDecoder().decode(fake.sent[0]!.body)).not.toContain(
      "SECRET-1",
    );
  });

  it("tolerates a missing client and a target that refuses listeners", () => {
    expect(() => attachBrowserHooks(null as never)()).not.toThrow();
    const { client } = setup();
    const refusing = {
      addEventListener() {
        throw new Error("no");
      },
      removeEventListener() {
        throw new Error("no");
      },
    };
    expect(() =>
      attachBrowserHooks(client, { target: refusing, document: refusing })(),
    ).not.toThrow();
  });

  it("sends cors from a worker by default", async () => {
    vi.stubGlobal("WorkerGlobalScope", function WorkerGlobalScope() {});
    try {
      const fake = createFakeFetch([], { status: 200 });
      const c = createTracerClient({ dsn: fixtureDsn, fetch: fake.fetch });
      await c.report("r");
      await c.flush();
      expect(fake.sent[0]!.init.mode).toBe("cors");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
