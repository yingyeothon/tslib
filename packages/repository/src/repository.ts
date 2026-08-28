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

/** A stored value together with the opaque token `compareAndSet` needs. */
export interface Revision<T> {
  value: T;
  /**
   * Identifies exactly this stored version. What it is depends on the
   * backend (an ETag, a content hash, a row revision); callers only pass it
   * back to `compareAndSet`.
   */
  token: string;
}

export interface CompareAndSetOptions {
  /** Applied to the written value when the backend supports per-key TTLs. */
  expiresInMillis?: number;
}

/**
 * A repository whose writes can be conditioned on what was read, so two
 * writers racing on one key cannot silently overwrite each other.
 */
export interface CasRepository extends Repository {
  /** Reads a value with the revision token `compareAndSet` needs. */
  getRevision<T>(key: string): Promise<Revision<T> | undefined>;
  /**
   * Writes `value` only if the key still holds the revision `expectedToken`;
   * `undefined` means the key must not exist. Resolves `false` — without
   * writing — when that condition no longer holds.
   */
  compareAndSet<T>(
    key: string,
    expectedToken: string | undefined,
    value: T,
    options?: CompareAndSetOptions,
  ): Promise<boolean>;
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
  getRevision?(
    key: string,
  ): Promise<{ serialized: string; token: string } | undefined>;
  compareAndSet?(
    key: string,
    expectedToken: string | undefined,
    serialized: string,
    expiresInMillis?: number,
  ): Promise<boolean>;
}

type WithExpire = Required<Pick<KVPrimitives, "setWithExpire">>;
type WithCas = Required<Pick<KVPrimitives, "getRevision" | "compareAndSet">>;

export function createRepositoryFromKV(
  primitives: KVPrimitives & WithExpire & WithCas,
): ExpirableRepository & CasRepository;
export function createRepositoryFromKV(
  primitives: KVPrimitives & WithExpire,
): ExpirableRepository;
export function createRepositoryFromKV(
  primitives: KVPrimitives & WithCas,
): CasRepository;
export function createRepositoryFromKV(primitives: KVPrimitives): Repository;
export function createRepositoryFromKV(
  primitives: KVPrimitives,
): Repository | ExpirableRepository | CasRepository {
  function serialize(value: unknown): string {
    if (value === undefined) {
      // `JSON.stringify(undefined)` is `undefined`, which a backend would
      // store as an empty body that no reader can parse back.
      throw new Error("Cannot store undefined; use delete to remove a key.");
    }
    return JSON.stringify(value);
  }
  let repository: Repository = {
    async get<T>(key: string): Promise<T | undefined> {
      const serialized = await primitives.get(key);
      if (serialized === undefined) {
        return undefined;
      }
      return JSON.parse(serialized) as T;
    },
    async set<T>(key: string, value: T): Promise<void> {
      await primitives.set(key, serialize(value));
    },
    async delete(key: string): Promise<void> {
      await primitives.delete(key);
    },
  };
  const setWithExpire = primitives.setWithExpire?.bind(primitives);
  if (setWithExpire) {
    const expirable: ExpirableRepository = {
      ...repository,
      async setWithExpire<T>(
        key: string,
        value: T,
        expiresInMillis: number,
      ): Promise<void> {
        await setWithExpire(key, serialize(value), expiresInMillis);
      },
    };
    repository = expirable;
  }
  const getRevision = primitives.getRevision?.bind(primitives);
  const compareAndSet = primitives.compareAndSet?.bind(primitives);
  if (getRevision && compareAndSet) {
    const cas: CasRepository = {
      ...repository,
      async getRevision<T>(key: string): Promise<Revision<T> | undefined> {
        const revision = await getRevision(key);
        if (revision === undefined) {
          return undefined;
        }
        return {
          value: JSON.parse(revision.serialized) as T,
          token: revision.token,
        };
      },
      async compareAndSet<T>(
        key: string,
        expectedToken: string | undefined,
        value: T,
        { expiresInMillis }: CompareAndSetOptions = {},
      ): Promise<boolean> {
        return await compareAndSet(
          key,
          expectedToken,
          serialize(value),
          expiresInMillis,
        );
      },
    };
    repository = cas;
  }
  return repository;
}

/** True when `repository` can do conditional writes. */
export function isCasRepository(
  repository: Repository,
): repository is CasRepository {
  return (
    typeof (repository as Partial<CasRepository>).getRevision === "function" &&
    typeof (repository as Partial<CasRepository>).compareAndSet === "function"
  );
}

/** True when `repository` can write with a TTL. */
export function isExpirableRepository(
  repository: Repository,
): repository is ExpirableRepository {
  return (
    typeof (repository as Partial<ExpirableRepository>).setWithExpire ===
    "function"
  );
}
