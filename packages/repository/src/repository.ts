export interface Repository {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ExpirableRepository extends Repository {
  setWithExpire<T>(
    key: string,
    value: T,
    expiresInMillis: number,
  ): Promise<void>;
}

export interface KVPrimitives {
  get(key: string): Promise<string | undefined>;
  set(key: string, serialized: string): Promise<void>;
  delete(key: string): Promise<void>;
  setWithExpire?(
    key: string,
    serialized: string,
    expiresInMillis: number,
  ): Promise<void>;
}

export function createRepositoryFromKV(
  primitives: KVPrimitives & Required<Pick<KVPrimitives, "setWithExpire">>,
): ExpirableRepository;
export function createRepositoryFromKV(primitives: KVPrimitives): Repository;
export function createRepositoryFromKV(
  primitives: KVPrimitives,
): Repository | ExpirableRepository {
  const repository: Repository = {
    async get<T>(key: string): Promise<T | undefined> {
      const serialized = await primitives.get(key);
      if (serialized === undefined) {
        return undefined;
      }
      return JSON.parse(serialized) as T;
    },
    async set<T>(key: string, value: T): Promise<void> {
      await primitives.set(key, JSON.stringify(value));
    },
    async delete(key: string): Promise<void> {
      await primitives.delete(key);
    },
  };
  const setWithExpire = primitives.setWithExpire?.bind(primitives);
  if (!setWithExpire) {
    return repository;
  }
  return {
    ...repository,
    async setWithExpire<T>(
      key: string,
      value: T,
      expiresInMillis: number,
    ): Promise<void> {
      await setWithExpire(key, JSON.stringify(value), expiresInMillis);
    },
  };
}
