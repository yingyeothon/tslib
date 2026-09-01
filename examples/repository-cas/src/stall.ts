import type {
  CasRepository,
  CompareAndSetOptions,
  ExpirableRepository,
} from "@yingyeothon/repository";

/** What both backends in this example satisfy. */
export type CasStore = ExpirableRepository & CasRepository;

export interface StalledStore {
  repository: CasStore;
  /** Resolves once the first conditional write has been intercepted. */
  readonly firstWriteReached: Promise<void>;
  /** Lets that intercepted write proceed. */
  release: () => void;
}

/**
 * Wraps a store so the *first* `compareAndSet` waits to be released.
 *
 * A race is only worth demonstrating if it happens every time. Two real
 * writers on two real connections interleave differently on every run, so the
 * interesting order — the loser reads, the winner commits, then the loser
 * writes — shows up rarely and cannot be asserted. Holding the first
 * conditional write open makes that order the only possible one.
 */
export function stallFirstWrite(inner: CasStore): StalledStore {
  let reached!: () => void;
  const firstWriteReached = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  let stalled = false;
  const repository: CasStore = {
    ...inner,
    get: (key) => inner.get(key),
    set: (key, value) => inner.set(key, value),
    setWithExpire: (key, value, expiresInMillis) =>
      inner.setWithExpire(key, value, expiresInMillis),
    delete: (key) => inner.delete(key),
    getRevision: (key) => inner.getRevision(key),
    compareAndSet: async <T>(
      key: string,
      expectedToken: string | undefined,
      value: T,
      options?: CompareAndSetOptions,
    ) => {
      if (!stalled) {
        stalled = true;
        reached();
        await released;
      }
      return inner.compareAndSet(key, expectedToken, value, options);
    },
  };

  return { repository, firstWriteReached, release };
}
