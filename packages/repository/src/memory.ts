import type { ExpirableRepository } from "./repository.js";
import { SimpleRepository } from "./repository.js";

interface ExpirableEntry {
  expired?: number;
  value: unknown;
}

export class InMemoryRepository
  extends SimpleRepository
  implements ExpirableRepository
{
  private readonly store = new Map<string, ExpirableEntry>();

  public get<T>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);
    if (!entry) {
      return Promise.resolve(undefined);
    }
    if (entry.expired && entry.expired > 0 && entry.expired < Date.now()) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(entry.value as T);
  }

  public set<T>(key: string, value: T): Promise<void> {
    this.store.set(key, { value });
    return Promise.resolve();
  }

  public delete(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }

  public setWithExpire<T>(
    key: string,
    value: T,
    expiresInMillis: number,
  ): Promise<void> {
    this.store.set(key, {
      expired: expiresInMillis > 0 ? Date.now() + expiresInMillis : 0,
      value,
    });
    return Promise.resolve();
  }
}
