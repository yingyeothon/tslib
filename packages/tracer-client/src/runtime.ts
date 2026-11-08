/**
 * The WHATWG globals the client uses, typed structurally: the DOM lib and
 * `undici-types` stay out of the public `.d.ts`, and no `node:` import keeps
 * the package loadable in a browser.
 */

interface StreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

interface StreamWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

interface TransformLike {
  readable: { getReader(): StreamReader };
  writable: { getWriter(): StreamWriter };
}

type CompressionStreamCtor = new (format: "gzip") => TransformLike;

interface TimerHandle {
  unref?: () => void;
}

interface Scope {
  CompressionStream?: CompressionStreamCtor;
  AbortController?: new () => { signal: unknown; abort(): void };
  crypto?: { getRandomValues(array: Uint8Array): Uint8Array };
  document?: unknown;
  WorkerGlobalScope?: unknown;
  setTimeout(handler: () => void, millis: number): unknown;
  clearTimeout(handle: unknown): void;
}

const scope = globalThis as unknown as Scope;

/** Whether this runtime gzips with `CompressionStream`. */
export function gzipAvailable(): boolean {
  return typeof scope.CompressionStream === "function";
}

/** Gzips `bytes` with `CompressionStream`; callers check `gzipAvailable`. */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const Ctor = scope.CompressionStream as CompressionStreamCtor;
  const stream = new Ctor("gzip");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  // Read while writing: a transform stream's queue would otherwise fill and
  // the write would never settle.
  const reading = (async () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        chunks.push(value);
        size += value.length;
      }
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  })();
  const [, out] = await Promise.all([
    writer.write(bytes).then(() => writer.close()),
    reading,
  ]);
  return out;
}

/** `crypto.getRandomValues`, the default id source. */
export function secureRandomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  if (typeof scope.crypto?.getRandomValues === "function") {
    scope.crypto.getRandomValues(out);
  } else {
    for (let i = 0; i < length; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

/** A browser window or worker: the `corsSafe` default. */
export function isBrowser(): boolean {
  return (
    (typeof scope.document === "object" && scope.document !== null) ||
    typeof scope.WorkerGlobalScope === "function"
  );
}

/**
 * `setTimeout` that does not keep a Node process alive: a script exits
 * without waiting for the next log flush (call `close()` to send it).
 */
export function startTimer(handler: () => void, millis: number): unknown {
  const handle = scope.setTimeout(handler, millis);
  (handle as TimerHandle | undefined)?.unref?.();
  return handle;
}

export function stopTimer(handle: unknown): void {
  if (handle !== undefined) scope.clearTimeout(handle);
}

/** An abort signal and its trigger; `undefined` where there is none. */
export function createAbort(): { signal: unknown; abort(): void } | undefined {
  return typeof scope.AbortController === "function"
    ? new scope.AbortController()
    : undefined;
}
