import type { TracerClient } from "./types.js";
import { withoutQuery } from "./stack.js";
import { clipUtf8, text } from "./wire.js";

/** Structural view of a DOM `EventTarget` (a window, a worker, a document). */
export interface TracerEventTarget {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  /** Read on `visibilitychange` when the target is a document. */
  visibilityState?: string;
}

export interface AttachBrowserHooksOptions {
  /** Where `error`, `unhandledrejection` and `pagehide` fire; default `globalThis`. */
  target?: TracerEventTarget;
  /** Where `visibilitychange` fires; default `globalThis.document`. */
  document?: TracerEventTarget;
  /** Breadcrumbs for uncaught errors and unhandled rejections; default `true`. */
  errors?: boolean;
  /**
   * Also send each uncaught error and unhandled rejection as a report, with
   * its stack, at level `error`; default `false`.
   */
  reportErrors?: boolean;
  /** Reports `reportErrors` sends at most, per attach; default 10. */
  maxReports?: number;
  /** `flush()` when the page is hidden or unloads; default `true`. */
  flushOnHide?: boolean;
}

function isTarget(value: unknown): value is TracerEventTarget {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as TracerEventTarget).addEventListener === "function" &&
    typeof (value as TracerEventTarget).removeEventListener === "function"
  );
}

function describe(error: unknown, fallback: unknown): string {
  if (typeof error === "object" && error !== null) {
    const e = error as { name?: unknown; message?: unknown };
    if (typeof e.message === "string") {
      return `${typeof e.name === "string" ? e.name : "Error"}: ${e.message}`;
    }
  }
  if (error !== undefined && error !== null) return text(error);
  return text(fallback ?? "unknown error");
}

/**
 * Wires a page (or worker) to `client`: uncaught errors and unhandled
 * rejections become breadcrumbs (and optionally reports), and a hidden or
 * unloading page flushes the buffered logs while it still can. Returns a
 * function that removes every listener it added. Does nothing where there is
 * no event target.
 */
export function attachBrowserHooks(
  client: TracerClient,
  options?: AttachBrowserHooksOptions,
): () => void {
  if (typeof client !== "object" || client === null) return () => undefined;
  options = options ?? {};
  const scope = globalThis as { document?: unknown };
  const global: unknown = globalThis;
  const target = options.target ?? (isTarget(global) ? global : undefined);
  const doc =
    options.document ?? (isTarget(scope.document) ? scope.document : undefined);
  const added: [TracerEventTarget, string, (event: unknown) => void][] = [];
  const on = (
    where: TracerEventTarget | undefined,
    type: string,
    listener: (event: unknown) => void,
  ) => {
    if (where === undefined) return;
    const safe = (event: unknown) => {
      try {
        listener(event);
      } catch {
        // A listener of ours must never surface as one more page error.
      }
    };
    try {
      where.addEventListener(type, safe);
      added.push([where, type, safe]);
    } catch {
      // A target that refuses listeners gets none.
    }
  };

  let reportsLeft =
    typeof options.maxReports === "number" ? options.maxReports : 10;
  const capture = (
    category: string,
    message: string,
    error: unknown,
    data: Record<string, unknown>,
  ) => {
    const msg = clipUtf8(message, 1024);
    client.breadcrumb(category, msg, { data, level: "error" });
    if (options.reportErrors === true && reportsLeft > 0) {
      reportsLeft--;
      void client.report(msg, { error, level: "error" });
    }
  };

  if (options.errors !== false) {
    on(target, "error", (event) => {
      const e = event as {
        error?: unknown;
        message?: unknown;
        filename?: unknown;
        lineno?: unknown;
        colno?: unknown;
      };
      capture("error", describe(e.error, e.message), e.error, {
        filename:
          typeof e.filename === "string" ? withoutQuery(e.filename) : undefined,
        lineno: e.lineno,
        colno: e.colno,
      });
    });
    on(target, "unhandledrejection", (event) => {
      const reason = (event as { reason?: unknown }).reason;
      capture("unhandledrejection", describe(reason, "rejected"), reason, {});
    });
  }
  if (options.flushOnHide !== false) {
    const flush = () => void client.flush({ unloading: true });
    on(target, "pagehide", flush);
    on(doc, "visibilitychange", () => {
      if (doc?.visibilityState === "hidden") flush();
    });
  }
  return () => {
    for (const [where, type, listener] of added.splice(0)) {
      try {
        where.removeEventListener(type, listener);
      } catch {
        // nothing left to undo
      }
    }
  };
}

interface BlobLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Structural view of an `HTMLCanvasElement` (`toBlob`) or an
 * `OffscreenCanvas` (`convertToBlob`).
 */
export interface CanvasLike {
  toBlob?(callback: (blob: BlobLike | null) => void, type?: string): void;
  convertToBlob?(options?: { type?: string }): Promise<BlobLike>;
}

/**
 * The canvas as PNG bytes for `report({ screenshot })`, or `undefined` when
 * it cannot be read (a cross-origin image tainted it, it has no size). A
 * WebGL canvas reads blank unless it was created with
 * `preserveDrawingBuffer: true` or this runs right after a frame is drawn.
 * Never throws.
 */
export async function captureCanvasScreenshot(
  canvas: CanvasLike,
): Promise<Uint8Array | undefined> {
  try {
    let blob: BlobLike | null;
    if (typeof canvas.convertToBlob === "function") {
      blob = await canvas.convertToBlob({ type: "image/png" });
    } else if (typeof canvas.toBlob === "function") {
      const toBlob = canvas.toBlob.bind(canvas);
      blob = await new Promise<BlobLike | null>((resolve) =>
        toBlob(resolve, "image/png"),
      );
    } else {
      return undefined;
    }
    if (blob === null) return undefined;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return bytes.length > 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
}
