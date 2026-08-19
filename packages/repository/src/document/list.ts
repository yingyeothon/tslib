import type { Repository } from "../repository.js";
import type { Versioned } from "./versioned.js";

export type Values<V> = V[];

export class ListDocument<V = string> {
  constructor(
    private readonly repository: Repository,
    private readonly tupleKey: string,
  ) {}

  public async insert(value: V): Promise<Versioned<Values<V>>> {
    return this.edit((values) => [...values, value]);
  }

  public async deleteIf(
    filter: (input: V) => boolean,
  ): Promise<Versioned<Values<V>>> {
    return this.edit((values) => values.filter((value) => !filter(value)));
  }

  public async truncate(): Promise<void> {
    return this.repository.delete(this.tupleKey);
  }

  public async read(): Promise<Versioned<Values<V>>> {
    const actual = await this.repository.get<Versioned<Values<V>>>(
      this.tupleKey,
    );
    return ensureDocument(actual);
  }

  public async edit(
    modifier: (input: V[]) => V[],
  ): Promise<Versioned<Values<V>>> {
    const doc = await this.read();
    const newDoc = {
      content: modifier(doc.content),
      version: doc.version + 1,
    };
    await this.repository.set(this.tupleKey, newDoc);
    return newDoc;
  }

  public async view<U>(selector: (input: V[]) => U): Promise<U> {
    return selector((await this.read()).content);
  }
}

function ensureDocument<V>(
  doc: Versioned<Values<V>> | undefined,
): Versioned<Values<V>> {
  return {
    version: doc?.version ? doc.version : 0,
    content: doc?.content ? doc.content : [],
  };
}
