import { createHash } from "node:crypto";
import type {
  CasRepository,
  ExpirableRepository,
  Repository,
} from "./repository.js";

interface ExpirableEntry {
  expired?: number;
  value: unknown;
  /** Fixed at write time: a modifier that mutates the stored object in
   *  place must not change what its own read handed out. */
  token: string;
}

export type InMemoryRepository = ExpirableRepository & CasRepository;

/**
 * Revision token for the in-memory backend: a hash of the serialized value,
 * like the Redis backend uses, so a document test against memory exercises
 * the same "same bytes, same token" semantics.
 */
function tokenOf(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex");
}

export function createInMemoryRepository(): InMemoryRepository {
  const store = new Map<string, ExpirableEntry>();

  function live(key: string): ExpirableEntry | undefined {
    const entry = store.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expired && entry.expired > 0 && entry.expired < Date.now()) {
      return undefined;
    }
    return entry;
  }

  function write(key: string, value: unknown, expiresInMillis?: number): void {
    store.set(key, {
      expired:
        expiresInMillis !== undefined && expiresInMillis > 0
          ? Date.now() + expiresInMillis
          : 0,
      value,
      token: tokenOf(value),
    });
  }

  const repository: Repository = {
    get<T>(key: string): Promise<T | undefined> {
      return Promise.resolve(live(key)?.value as T | undefined);
    },
    set<T>(key: string, value: T): Promise<void> {
      write(key, value);
      return Promise.resolve();
    },
    delete(key: string): Promise<void> {
      store.delete(key);
      return Promise.resolve();
    },
  };
  return {
    ...repository,
    setWithExpire<T>(
      key: string,
      value: T,
      expiresInMillis: number,
    ): Promise<void> {
      write(key, value, expiresInMillis);
      return Promise.resolve();
    },
    getRevision<T>(key: string) {
      const entry = live(key);
      return Promise.resolve(
        entry === undefined
          ? undefined
          : { value: entry.value as T, token: entry.token },
      );
    },
    compareAndSet<T>(
      key: string,
      expectedToken: string | undefined,
      value: T,
      { expiresInMillis }: { expiresInMillis?: number } = {},
    ): Promise<boolean> {
      const entry = live(key);
      if (entry?.token !== expectedToken) {
        return Promise.resolve(false);
      }
      write(key, value, expiresInMillis);
      return Promise.resolve(true);
    },
  };
}
