import type { ExpirableRepository } from "./repository.js";

interface ExpirableEntry {
  expired?: number;
  value: unknown;
}

export type InMemoryRepository = ExpirableRepository;

export function createInMemoryRepository(): InMemoryRepository {
  const store = new Map<string, ExpirableEntry>();
  return {
    get<T>(key: string): Promise<T | undefined> {
      const entry = store.get(key);
      if (!entry) {
        return Promise.resolve(undefined);
      }
      if (entry.expired && entry.expired > 0 && entry.expired < Date.now()) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(entry.value as T);
    },
    set<T>(key: string, value: T): Promise<void> {
      store.set(key, { value });
      return Promise.resolve();
    },
    delete(key: string): Promise<void> {
      store.delete(key);
      return Promise.resolve();
    },
    setWithExpire<T>(
      key: string,
      value: T,
      expiresInMillis: number,
    ): Promise<void> {
      store.set(key, {
        expired: expiresInMillis > 0 ? Date.now() + expiresInMillis : 0,
        value,
      });
      return Promise.resolve();
    },
  };
}
