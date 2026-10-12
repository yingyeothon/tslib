import { nullLogger, type Logger } from "@yingyeothon/logger";
import {
  createKvStoreClient,
  type KvNamespace,
} from "@yingyeothon/kvstore-client";
import type {
  GameKitOptions,
  KitError,
  KitErrorCode,
  KitScheduler,
  SessionIdentity,
} from "./types.js";

export function kitError(
  module: string,
  code: KitErrorCode,
  cause?: { status?: number; code?: string },
): KitError {
  return Object.assign(new Error(`kit ${module}: ${code}`), {
    name: "KitError" as const,
    module,
    code,
    retryable: ["offline", "conflict", "unavailable", "rate_limited"].includes(
      code,
    ),
    ...(cause === undefined ? {} : { cause }),
  });
}
export function isKitError(value: unknown): value is KitError {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    value.name === "KitError" &&
    "code" in value &&
    typeof value.code === "string" &&
    "module" in value &&
    typeof value.module === "string" &&
    "retryable" in value &&
    typeof value.retryable === "boolean"
  );
}
export function mapError(module: string, error: unknown): KitError {
  if (isKitError(error)) return error;
  const e = (typeof error === "object" && error !== null ? error : {}) as {
    status?: number;
    code?: string;
    reason?: string;
  };
  const code: KitErrorCode =
    e.status === 401
      ? "signed_out"
      : e.status === 403
        ? "forbidden"
        : e.status === 410
          ? "channel_inactive"
          : e.status === 429
            ? "rate_limited"
            : e.reason === "out_of_range"
              ? "out_of_range"
              : e.status === 409
                ? "conflict"
                : "unavailable";
  return kitError(module, code, {
    ...(typeof e.status === "number" ? { status: e.status } : {}),
    ...(typeof e.code === "string" ? { code: e.code } : {}),
  });
}
export function emitter() {
  const handlers = new Map<string, Set<(value: unknown) => void>>();
  return {
    on(name: string, handler: (value: unknown) => void) {
      const set = handlers.get(name) ?? new Set();
      handlers.set(name, set);
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
    emit(name: string, value?: unknown) {
      for (const handler of [...(handlers.get(name) ?? [])]) {
        try {
          handler(value);
        } catch {
          /* A user observer cannot stop lifecycle cleanup. */
        }
      }
    },
    clear() {
      handlers.clear();
    },
  };
}
export function defaultScheduler(): KitScheduler {
  return {
    now: () => performance.now(),
    schedule(callback, delay) {
      const deadline = performance.now() + delay;
      let timer: ReturnType<typeof setTimeout>;
      let cancelled = false;
      const tick = () => {
        if (cancelled) return;
        const remaining = deadline - performance.now();
        if (remaining <= 0) callback();
        else timer = setTimeout(tick, Math.min(remaining, 2147483647));
      };
      timer = setTimeout(tick, Math.min(Math.max(0, delay), 2147483647));
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    },
  };
}
export interface Runtime {
  options: GameKitOptions;
  logger: Logger;
  clock: KitScheduler;
  identity?: SessionIdentity;
  generation: number;
  foreground: boolean;
  disposed: boolean;
  events: ReturnType<typeof emitter>;
  stop(): void;
  change(): void;
  kv(module: "content" | "save"): KvNamespace;
  run<T>(module: string, action: () => Promise<T>): Promise<T>;
  background(module: string, action: Promise<unknown>): void;
}
export function createRuntime(options: GameKitOptions): Runtime {
  const runtime: Runtime = {
    options,
    logger: options.logger ?? nullLogger,
    clock: options.scheduler ?? defaultScheduler(),
    generation: 0,
    foreground: true,
    disposed: false,
    events: emitter(),
    stop() {
      runtime.generation++;
      runtime.identity = undefined;
      runtime.events.emit("stop");
      runtime.events.emit("signedOut");
    },
    change() {
      runtime.generation++;
      runtime.events.emit("change");
    },
    kv(module) {
      const collection = options.config.collections?.[module];
      const url = options.config.state?.url;
      if (!collection || !url) throw kitError(module, "not_configured");
      if (!runtime.identity || runtime.disposed)
        throw kitError(module, "signed_out");
      const client = createKvStoreClient({
        baseUrl: url,
        token: runtime.identity.token,
        fetch: options.fetch,
        logger: nullLogger,
      }).collection(collection);
      return module === "save" ? client.mine : client;
    },
    async run<T>(module: string, action: () => Promise<T>): Promise<T> {
      if (!runtime.identity || runtime.disposed)
        throw kitError(module, "signed_out");
      const generation = runtime.generation;
      try {
        const result = await action();
        if (generation !== runtime.generation)
          throw kitError(module, "signed_out");
        return result;
      } catch (error) {
        if (generation !== runtime.generation)
          throw kitError(module, "signed_out");
        if (error instanceof RangeError || error instanceof TypeError)
          throw error;
        const mapped = mapError(module, error);
        if (mapped.code === "signed_out") runtime.stop();
        throw mapped;
      }
    },
    background(module, action) {
      void action.catch((error) => {
        const e = mapError(module, error);
        runtime.logger.warn("kit background operation failed", {
          module,
          code: e.code,
        });
      });
    },
  };
  return runtime;
}
