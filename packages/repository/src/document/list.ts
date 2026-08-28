import type { Repository } from "../repository.js";
import type { Versioned } from "./versioned.js";
import {
  editDocument,
  ensureDocument,
  type DocumentWriteOptions,
} from "./write.js";

export type Values<V> = V[];

export interface ListDocument<V = string> {
  insert(value: V): Promise<Versioned<Values<V>>>;
  deleteIf(filter: (input: V) => boolean): Promise<Versioned<Values<V>>>;
  truncate(): Promise<void>;
  read(): Promise<Versioned<Values<V>>>;
  edit(modifier: (input: V[]) => V[]): Promise<Versioned<Values<V>>>;
  view<U>(selector: (input: V[]) => U): Promise<U>;
}

export interface ListDocumentOptions extends DocumentWriteOptions {
  repository: Repository;
  key: string;
}

const empty = <V>(): Values<V> => [];

export function createListDocument<V = string>(
  options: ListDocumentOptions,
): ListDocument<V> {
  const { repository, key, ...writeOptions } = options;

  async function read(): Promise<Versioned<Values<V>>> {
    const actual = await repository.get<Versioned<Values<V>>>(key);
    return ensureDocument(actual, empty<V>);
  }

  function edit(modifier: (input: V[]) => V[]): Promise<Versioned<Values<V>>> {
    return editDocument(repository, key, empty<V>, modifier, writeOptions);
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
