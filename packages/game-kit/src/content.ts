import { kitError, type Runtime } from "./runtime.js";
import type { Content } from "./types.js";

export function createContent(runtime: Runtime): Content {
  const cache = new Map<string, { value: unknown; version?: number }>();
  const pending = new Map<string, Promise<unknown>>();
  const subscriptions = new Map<string, Set<(value: unknown) => void>>();
  const timers = new Map<string, () => void>();
  const interval = runtime.options.content?.pollIntervalMs ?? 60000;
  if (!Number.isFinite(interval) || interval < 1000)
    throw new RangeError("content pollIntervalMs must be at least 1000");
  function stop() {
    for (const cancel of timers.values()) cancel();
    timers.clear();
  }
  function arm(key: string) {
    if (
      !runtime.foreground ||
      !runtime.identity ||
      runtime.disposed ||
      !subscriptions.has(key)
    )
      return;
    timers.get(key)?.();
    timers.set(
      key,
      runtime.clock.schedule(() => {
        timers.delete(key);
        runtime.background(
          "content",
          refresh(key).finally(() => arm(key)),
        );
      }, interval),
    );
  }
  async function refresh(key: string): Promise<unknown> {
    const current = pending.get(key);
    if (current) return current;
    const generation = runtime.generation;
    const task = runtime
      .run("content", () => runtime.kv("content").getEntry(key))
      .then((entry) => {
        if (generation !== runtime.generation)
          throw kitError("content", "signed_out");
        const old = cache.get(key);
        const changed = !cache.has(key) || old?.version !== entry?.version;
        cache.set(key, {
          value: entry?.value,
          ...(entry === undefined ? {} : { version: entry.version }),
        });
        if (changed)
          for (const handler of [...(subscriptions.get(key) ?? [])]) {
            try {
              handler(entry?.value);
            } catch {
              runtime.logger.warn("content subscriber failed", {
                module: "content",
              });
            }
          }
        return entry?.value;
      });
    pending.set(key, task);
    try {
      return await task;
    } finally {
      if (pending.get(key) === task) pending.delete(key);
    }
  }
  runtime.events.on("stop", () => {
    stop();
    cache.clear();
    pending.clear();
  });
  runtime.events.on("change", () => {
    stop();
    cache.clear();
    pending.clear();
    for (const key of subscriptions.keys()) {
      runtime.background("content", refresh(key));
      arm(key);
    }
  });
  runtime.events.on("foreground", () => {
    stop();
    if (runtime.foreground)
      for (const key of subscriptions.keys()) {
        runtime.background(
          "content",
          (pending.get(key) ?? Promise.resolve())
            .catch(() => {})
            .then(() => {
              if (runtime.foreground && runtime.identity) return refresh(key);
            }),
        );
        arm(key);
      }
  });
  runtime.events.on("dispose", () => {
    stop();
    subscriptions.clear();
    cache.clear();
    pending.clear();
  });
  return {
    async get<T>(key: string): Promise<T | undefined> {
      runtime.kv("content");
      if (cache.has(key)) {
        runtime.background("content", refresh(key));
        return cache.get(key)?.value as T | undefined;
      }
      return (await refresh(key)) as T | undefined;
    },
    async list<T>(options = {}) {
      return runtime.run("content", async () => {
        const values: { key: string; value: T }[] = [];
        let cursor: string | undefined;
        do {
          const page = await runtime
            .kv("content")
            .list<T>({ ...options, cursor, values: true });
          for (const row of page.entries)
            if (row.value !== undefined)
              values.push({ key: row.key, value: row.value });
          cursor = page.nextCursor;
        } while (cursor);
        return values;
      });
    },
    subscribe<T>(key: string, handler: (value: T | undefined) => void) {
      if (
        !runtime.options.config.collections?.content ||
        !runtime.options.config.state
      )
        throw kitError("content", "not_configured");
      const set = subscriptions.get(key) ?? new Set();
      subscriptions.set(key, set);
      const listener = handler as (value: unknown) => void;
      set.add(listener);
      if (cache.has(key)) {
        try {
          listener(cache.get(key)?.value);
        } catch {
          runtime.logger.warn("content subscriber failed", {
            module: "content",
          });
        }
      }
      if (runtime.identity) runtime.background("content", refresh(key));
      arm(key);
      return () => {
        set.delete(listener);
        if (!set.size) {
          subscriptions.delete(key);
          timers.get(key)?.();
          timers.delete(key);
        }
      };
    },
  };
}
