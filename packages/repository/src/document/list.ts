import type { Repository } from "../repository.js";
import type { Versioned } from "./versioned.js";

export type Values<V> = V[];

export interface ListDocument<V = string> {
  insert(value: V): Promise<Versioned<Values<V>>>;
  deleteIf(filter: (input: V) => boolean): Promise<Versioned<Values<V>>>;
  truncate(): Promise<void>;
  read(): Promise<Versioned<Values<V>>>;
  edit(modifier: (input: V[]) => V[]): Promise<Versioned<Values<V>>>;
  view<U>(selector: (input: V[]) => U): Promise<U>;
}

export interface ListDocumentOptions {
  repository: Repository;
  key: string;
}

export function createListDocument<V = string>(
  options: ListDocumentOptions,
): ListDocument<V> {
  const { repository, key } = options;

  async function read(): Promise<Versioned<Values<V>>> {
    const actual = await repository.get<Versioned<Values<V>>>(key);
    return ensureDocument(actual);
  }

  async function edit(
    modifier: (input: V[]) => V[],
  ): Promise<Versioned<Values<V>>> {
    const doc = await read();
    const newDoc = {
      content: modifier(doc.content),
      version: doc.version + 1,
    };
    await repository.set(key, newDoc);
    return newDoc;
  }

  return {
    read,
    edit,
    insert: (value) => edit((values) => [...values, value]),
    deleteIf: (filter) =>
      edit((values) => values.filter((value) => !filter(value))),
    truncate: () => repository.delete(key),
    view: async (selector) => selector((await read()).content),
  };
}

function ensureDocument<V>(
  doc: Versioned<Values<V>> | undefined,
): Versioned<Values<V>> {
  return {
    version: doc?.version ? doc.version : 0,
    content: doc?.content ? doc.content : [],
  };
}
