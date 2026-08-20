import type { Repository } from "../repository.js";
import type { Versioned } from "./versioned.js";

export type KeyValues<V> = Record<string, V>;

export interface MapDocument<V = string> {
  insertOrUpdate(
    key: string,
    value: V | undefined,
  ): Promise<Versioned<KeyValues<V>>>;
  delete(key: string): Promise<Versioned<KeyValues<V>>>;
  truncate(): Promise<void>;
  read(): Promise<Versioned<KeyValues<V>>>;
  edit(
    modifier: (input: KeyValues<V>) => KeyValues<V>,
  ): Promise<Versioned<KeyValues<V>>>;
  view<U>(selector: (input: KeyValues<V>) => U): Promise<U>;
}

export interface MapDocumentOptions {
  repository: Repository;
  key: string;
}

export function createMapDocument<V = string>(
  options: MapDocumentOptions,
): MapDocument<V> {
  const { repository, key: tupleKey } = options;

  async function read(): Promise<Versioned<KeyValues<V>>> {
    const actual = await repository.get<Versioned<KeyValues<V>>>(tupleKey);
    return ensureDocument(actual);
  }

  async function edit(
    modifier: (input: KeyValues<V>) => KeyValues<V>,
  ): Promise<Versioned<KeyValues<V>>> {
    const doc = await read();
    const newDoc = {
      content: modifier(doc.content),
      version: doc.version + 1,
    };
    await repository.set(tupleKey, newDoc);
    return newDoc;
  }

  function insertOrUpdate(
    key: string,
    value: V | undefined,
  ): Promise<Versioned<KeyValues<V>>> {
    return edit((values) => {
      if (!value) {
        const copied = { ...values };
        delete copied[key];
        return copied;
      }
      return { ...values, [key]: value };
    });
  }

  return {
    read,
    edit,
    insertOrUpdate,
    delete: (key) => insertOrUpdate(key, undefined),
    truncate: () => repository.delete(tupleKey),
    view: async (selector) => selector((await read()).content),
  };
}

function ensureDocument<V>(
  doc: Versioned<KeyValues<V>> | undefined,
): Versioned<KeyValues<V>> {
  return {
    version: doc?.version ? doc.version : 0,
    content: doc?.content ? doc.content : {},
  };
}
