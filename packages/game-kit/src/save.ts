import {
  isKvConflict,
  isKvStoreError,
  kvMaxValueBytes,
} from "@yingyeothon/kvstore-client";
import { kitError, type Runtime } from "./runtime.js";
import type {
  MergePolicy,
  QueuedWrite,
  Save,
  SaveStoreOptions,
} from "./types.js";

function clone<T>(value: T, limit = Infinity): T {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new TypeError("save value must be JSON");
  }
  if (text === undefined) throw new TypeError("save value must be JSON");
  if (new TextEncoder().encode(text).length > limit)
    throw new RangeError("save value exceeds 16384 bytes");
  return JSON.parse(text) as T;
}
export function createSave(runtime: Runtime): Save {
  const cache = new Map<string, { value: unknown; version?: number }>();
  const inlineMerges = new Map<string, MergePolicy>();
  let writes: QueuedWrite[] = [];
  let namespace: string | undefined;
  let lane: Promise<unknown> = Promise.resolve();
  let operationGeneration: number | undefined;
  const guardOperation = () => {
    if (operationGeneration !== runtime.generation)
      throw kitError("save", "signed_out");
  };
  const adapter = runtime.options.save?.offlineQueue;
  function registeredMerge(name: string): MergePolicy | undefined {
    const policies = runtime.options.save?.mergePolicies;
    return policies && Object.hasOwn(policies, name)
      ? policies[name]
      : undefined;
  }
  const retries = runtime.options.save?.maxMergeRetries ?? 3;
  if (!Number.isSafeInteger(retries) || retries < 0)
    throw new RangeError("maxMergeRetries must be a non-negative integer");
  function serial<T>(action: () => Promise<T>): Promise<T> {
    const generation = runtime.generation;
    const task = lane
      .catch(() => {})
      .then(async () => {
        if (generation !== runtime.generation)
          throw kitError("save", "signed_out");
        operationGeneration = generation;
        try {
          const result = await action();
          guardOperation();
          return result;
        } finally {
          operationGeneration = undefined;
        }
      });
    lane = task.catch(() => {});
    return task;
  }
  function identityKey(): string {
    runtime.kv("save");
    return JSON.stringify([
      runtime.options.config.auth?.channelId ?? "",
      runtime.options.config.state?.url,
      runtime.options.config.collections?.save,
      runtime.identity!.userId,
    ]);
  }
  async function hydrate() {
    guardOperation();
    if (!adapter) return;
    const key = identityKey();
    if (namespace === key) return;
    const generation = runtime.generation;
    let loaded: QueuedWrite[];
    try {
      loaded = clone(await adapter.load(key));
    } catch {
      throw kitError("save", "unavailable");
    }
    if (generation !== runtime.generation) throw kitError("save", "signed_out");
    if (
      !Array.isArray(loaded) ||
      loaded.some(
        (w) =>
          !w ||
          typeof w.id !== "string" ||
          typeof w.name !== "string" ||
          !["store", "remove"].includes(w.kind),
      )
    )
      throw kitError("save", "invalid_state");
    namespace = key;
    writes = loaded;
  }
  function overlay(name: string): QueuedWrite | undefined {
    return [...writes].reverse().find((w) => w.name === name);
  }
  async function read(name: string): Promise<unknown> {
    runtime.kv("save");
    await hydrate();
    guardOperation();
    const staged = overlay(name);
    if (staged)
      return staged.kind === "remove" ? undefined : clone(staged.value);
    try {
      const entry = await runtime.run("save", () =>
        runtime.kv("save").getEntry(name),
      );
      guardOperation();
      cache.set(name, {
        value: entry?.value,
        ...(entry === undefined ? {} : { version: entry.version }),
      });
      return entry?.value === undefined ? undefined : clone(entry.value);
    } catch (error) {
      guardOperation();
      if (
        adapter &&
        cache.has(name) &&
        (error as { code?: string }).code === "unavailable"
      )
        return cache.get(name)?.value;
      throw error;
    }
  }
  async function persistQueue(next: QueuedWrite[]) {
    guardOperation();
    const generation = runtime.generation;
    const key = namespace!;
    try {
      await adapter!.store(key, clone(next));
    } catch {
      throw kitError("save", "unavailable");
    }
    if (generation !== runtime.generation) throw kitError("save", "signed_out");
    writes = next;
  }
  async function enqueue(write: QueuedWrite, merge?: MergePolicy) {
    await persistQueue([...writes, write]);
    if (merge) inlineMerges.set(write.id, merge);
  }
  async function apply(
    write: QueuedWrite,
    merge?: MergePolicy,
    recover = false,
  ) {
    guardOperation();
    const generation = runtime.generation;
    const kv = runtime.kv("save");
    if (recover) {
      const remote = await kv.getEntry(write.name);
      guardOperation();
      if (write.kind === "remove" && !remote) {
        cache.set(write.name, { value: undefined });
        return;
      }
      // A lost acknowledgement is recoverable when the desired state already
      // exists at a newer revision. This never overwrites another value.
      if (
        write.kind === "store" &&
        remote &&
        remote.version > (write.expectedVersion ?? 0) &&
        JSON.stringify(remote.value) === JSON.stringify(write.value)
      ) {
        cache.set(write.name, {
          value: clone(remote.value),
          version: remote.version,
        });
        return;
      }
    }
    const guard = () => {
      if (generation !== runtime.generation)
        throw kitError("save", "signed_out");
    };
    let expected = write.expectedVersion;
    let value = write.value;
    for (let attempt = 0; ; attempt++) {
      guard();
      try {
        if (write.kind === "remove") {
          if (expected !== undefined)
            await kv.delete(write.name, { ifMatch: expected });
          else {
            const row = await kv.getEntry(write.name);
            if (row) throw kitError("save", "conflict");
          }
          guard();
          cache.set(write.name, { value: undefined });
        } else {
          const result = await kv.put(write.name, value, {
            ...(expected === undefined
              ? { ifNoneMatch: true }
              : { ifMatch: expected }),
            ttl: write.ttl,
          });
          guard();
          cache.set(write.name, {
            value: clone(value),
            version: result.version,
          });
        }
        return;
      } catch (error) {
        if (
          !isKvConflict(error) ||
          !merge ||
          write.kind === "remove" ||
          attempt >= retries
        )
          throw error;
        const remote = await kv.getEntry(write.name);
        guard();
        value = clone(await merge(value, remote?.value));
        guard();
        expected = remote?.version;
        write.value = value;
        write.expectedVersion = expected;
        if (recover) await persistQueue([...writes]);
      }
    }
  }
  async function write(
    name: string,
    kind: "store" | "remove",
    value: unknown,
    options: SaveStoreOptions = {},
  ) {
    await hydrate();
    guardOperation();
    // A conditional base must be known before accepting an offline mutation.
    if (!cache.has(name) && !overlay(name)) await read(name);
    guardOperation();
    const previous = overlay(name);
    const expectedVersion = previous
      ? previous.kind === "remove"
        ? undefined
        : (previous.expectedVersion ?? 0) + 1
      : cache.get(name)?.version;
    const item: QueuedWrite = {
      id: crypto.randomUUID(),
      name,
      kind,
      ...(kind === "store" ? { value: clone(value, kvMaxValueBytes) } : {}),
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
      ...(options.ttl === undefined ? {} : { ttl: options.ttl }),
    };
    if (adapter && writes.length) {
      await enqueue(item, options.merge);
      return;
    }
    try {
      await runtime.run("save", () =>
        apply(item, options.merge ?? registeredMerge(name)),
      );
    } catch (error) {
      if (adapter && (error as { code?: string }).code === "unavailable") {
        await enqueue(item, options.merge);
        return;
      }
      throw error;
    }
  }
  async function flush() {
    if (!adapter || !runtime.foreground) return;
    await hydrate();
    guardOperation();
    while (
      writes.length &&
      runtime.foreground &&
      runtime.identity &&
      !runtime.disposed
    ) {
      const item = writes[0]!;
      await runtime.run("save", () =>
        apply(
          item,
          inlineMerges.get(item.id) ?? registeredMerge(item.name),
          true,
        ),
      );
      // A successful merge may advance the version by more than one. Rebase
      // this client's next queued write to the revision it actually committed.
      const next = writes.slice(1).map((w) => ({ ...w }));
      const following = next.find((w) => w.name === item.name);
      if (following) following.expectedVersion = cache.get(item.name)?.version;
      await persistQueue(next);
      inlineMerges.delete(item.id);
    }
  }
  runtime.events.on("change", () => {
    cache.clear();
    writes = [];
    namespace = undefined;
    inlineMerges.clear();
  });
  runtime.events.on("stop", () => {
    cache.clear();
    writes = [];
    namespace = undefined;
    inlineMerges.clear();
  });
  runtime.events.on("foreground", () => {
    if (runtime.foreground && runtime.identity)
      runtime.background("save", serial(flush));
  });
  runtime.events.on("dispose", () => {
    cache.clear();
    writes = [];
    inlineMerges.clear();
  });
  return {
    load<T>(name: string) {
      return serial(() => read(name)) as Promise<T | undefined>;
    },
    store(name, value, options) {
      return serial(() => write(name, "store", value, options));
    },
    update<T>(
      name: string,
      update: (value: T | undefined) => T,
      options?: SaveStoreOptions,
    ) {
      return serial(async () => {
        const value = (await read(name)) as T | undefined;
        await write(name, "store", update(value), options);
      });
    },
    remove(name) {
      return serial(() => write(name, "remove", undefined));
    },
    counter(name) {
      return {
        add(delta, options) {
          return serial(() =>
            runtime.run(
              "save",
              async () =>
                (await runtime.kv("save").incr(name, delta, options)).value,
            ),
          );
        },
      };
    },
    claimOnce(name, ttl) {
      return serial(() =>
        runtime.run("save", async () => {
          try {
            await runtime
              .kv("save")
              .put(name, true, { ifNoneMatch: true, ttl });
            return true;
          } catch (error) {
            if (
              isKvConflict(error) &&
              (!isKvStoreError(error) || error.reason === undefined)
            )
              return false;
            throw error;
          }
        }),
      );
    },
    get pendingCount() {
      return writes.length;
    },
    flush() {
      return serial(flush);
    },
  };
}
