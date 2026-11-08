import { clipUtf8, text, tracerLimits } from "./wire.js";

/** `    at fn (file:line:col)`, `    at file:line:col`, `    at async fn (…)`. */
const v8Frame =
  /^\s*at (?:(?:async )?(.+?) \((.+?):(\d+):(\d+)\)|(?:async )?(.+?):(\d+):(\d+))$/;

/** `fn@file:line:col` (SpiderMonkey, JavaScriptCore). */
const geckoFrame = /^\s*(.*?)@(.+?):(\d+):(\d+)$/;

const maxStackChars = 64 * 1024;
const maxFrameLineChars = 1024;

/** A location without its query and fragment (signed URLs, tokens). */
export function withoutQuery(location: string): string {
  return location.replace(/[?#].*$/, "");
}

export interface StackFrame {
  filename: string;
  function: string;
  lineno: number;
  colno: number;
  abs_path: string;
  in_app: boolean;
}

/**
 * The read API shows `filename`, not `abs_path`, and tracer groups by it, so
 * it is the part a reader recognises: a URL's path without the origin and the
 * cache-busting query, or a file path from `node_modules/` or `src/` on.
 */
function shortName(location: string): string {
  let path = location;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(path);
  if (scheme !== null) path = path.slice(scheme[0].length);
  else if (path.startsWith("file:")) path = path.slice("file:".length);
  path = path.replace(/[?#].*$/, "");
  const modules = path.lastIndexOf("/node_modules/");
  if (modules >= 0) return path.slice(modules + 1);
  // An inline script's location is the page itself (`https://host/`).
  return path.replace(/^\/+/, "") || location;
}

function inApp(location: string): boolean {
  return !(
    location.startsWith("node:") ||
    location.includes("/node_modules/") ||
    location.includes("/tracer-client/dist/") ||
    location === "<anonymous>" ||
    location === "native"
  );
}

/**
 * Frames of an `Error.stack`, oldest first (the Sentry order), the innermost
 * 200 kept. A stack in another format yields no frames.
 */
export function stackFrames(stack: unknown): StackFrame[] {
  if (typeof stack !== "string") return [];
  const frames: StackFrame[] = [];
  // The regexes backtrack on long lines, and the message part of a stack can
  // be anything: bound the work done on the caller's thread.
  for (const line of stack.slice(0, maxStackChars).split("\n")) {
    if (line.length > maxFrameLineChars) continue;
    const v8 = v8Frame.exec(line);
    const gecko = v8 === null ? geckoFrame.exec(line) : null;
    let fn: string | undefined;
    let location: string | undefined;
    let lineno: string | undefined;
    let colno: string | undefined;
    if (v8 !== null) {
      [fn, location, lineno, colno] =
        v8[2] !== undefined
          ? [v8[1], v8[2], v8[3], v8[4]]
          : [undefined, v8[5], v8[6], v8[7]];
    } else if (gecko !== null) {
      [fn, location, lineno, colno] = [gecko[1], gecko[2], gecko[3], gecko[4]];
    } else {
      continue;
    }
    if (location === undefined) continue;
    frames.push({
      filename: clipUtf8(shortName(location), 300),
      function: clipUtf8(fn === undefined || fn === "" ? "?" : fn, 300),
      lineno: Number(lineno),
      colno: Number(colno),
      abs_path: clipUtf8(withoutQuery(location), 400),
      in_app: inApp(location),
    });
    if (frames.length === 200) break;
  }
  return frames.reverse();
}

/** The event `exception` of a thrown value. */
export function exceptionOf(error: unknown): Record<string, unknown> {
  let type = "Error";
  let value: string;
  let stack: unknown;
  try {
    if (typeof error === "object" && error !== null) {
      const e = error as { name?: unknown; message?: unknown; stack?: unknown };
      type =
        typeof e.name === "string" && e.name !== ""
          ? e.name
          : text(
              (error as { constructor?: { name?: unknown } }).constructor?.name,
            );
      value = typeof e.message === "string" ? e.message : text(error);
      stack = e.stack;
    } else {
      type = typeof error;
      value = text(error);
    }
  } catch {
    value = "<unprintable>";
  }
  const frames = stackFrames(stack);
  return {
    values: [
      {
        type: clipUtf8(type, 200),
        value: clipUtf8(value, tracerLimits.maxTextBytes),
        ...(frames.length > 0 ? { stacktrace: { frames } } : {}),
      },
    ],
  };
}
