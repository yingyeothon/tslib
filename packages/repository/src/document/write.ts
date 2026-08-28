import {
  isCasRepository,
  isExpirableRepository,
  type Repository,
} from "../repository.js";
import type { Versioned } from "./versioned.js";

export interface DocumentWriteOptions {
  /**
   * TTL applied on every write. Required by backends that refuse TTL-less
   * keys (`@yingyeothon/repository-redis`); ignored by backends without
   * per-key expiry (`@yingyeothon/repository-s3`).
   */
  expiresInMillis?: number;
  /**
   * How many times a conditional write is retried after another writer
   * changed the document in between. Only meaningful on a `CasRepository`.
   * Default 3.
   */
  maxRetries?: number;
}

const defaultMaxRetries = 3;

export function ensureDocument<C>(
  doc: Versioned<C> | undefined,
  empty: () => C,
): Versioned<C> {
  return {
    version: doc?.version ? doc.version : 0,
    content: doc?.content ? doc.content : empty(),
  };
}

/**
 * Read-modify-write of one versioned document.
 *
 * On a `CasRepository` the write is conditioned on the revision that was
 * read, and retried from a fresh read when it lost the race; after
 * `maxRetries` losses it throws instead of guessing. On any other
 * repository the last writer wins, exactly as before, so callers there must
 * serialize writers themselves (the actor lock does).
 */
export async function editDocument<C>(
  repository: Repository,
  key: string,
  empty: () => C,
  modifier: (input: C) => C,
  { expiresInMillis, maxRetries = defaultMaxRetries }: DocumentWriteOptions,
): Promise<Versioned<C>> {
  if (!isCasRepository(repository)) {
    const doc = ensureDocument(await repository.get<Versioned<C>>(key), empty);
    const newDoc = { content: modifier(doc.content), version: doc.version + 1 };
    if (expiresInMillis !== undefined && isExpirableRepository(repository)) {
      await repository.setWithExpire(key, newDoc, expiresInMillis);
    } else {
      await repository.set(key, newDoc);
    }
    return newDoc;
  }

  for (let attempt = 0; ; attempt++) {
    const revision = await repository.getRevision<Versioned<C>>(key);
    const doc = ensureDocument(revision?.value, empty);
    const newDoc = { content: modifier(doc.content), version: doc.version + 1 };
    const written = await repository.compareAndSet(
      key,
      revision?.token,
      newDoc,
      { expiresInMillis },
    );
    if (written) {
      return newDoc;
    }
    if (attempt >= maxRetries) {
      throw new Error(
        `Concurrent modification of "${key}" (gave up after ${attempt + 1} attempts)`,
      );
    }
  }
}
