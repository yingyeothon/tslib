import type { Repository } from "../repository.js";
import type { Versioned } from "./versioned.js";

export type KeyValues<V> = Record<string, V>;

export class MapDocument<V = string> {
  constructor(
    private readonly repository: Repository,
    private readonly tupleKey: string,
  ) {}

  public async insertOrUpdate(
    key: string,
    value: V | undefined,
  ): Promise<Versioned<KeyValues<V>>> {
    return this.edit((values) => {
      if (!value) {
        const copied = { ...values };
        delete copied[key];
        return copied;
      }
      return { ...values, [key]: value };
    });
  }

  public async delete(key: string): Promise<Versioned<KeyValues<V>>> {
    return this.insertOrUpdate(key, undefined);
  }

  public async truncate(): Promise<void> {
    return this.repository.delete(this.tupleKey);
  }

  public async read(): Promise<Versioned<KeyValues<V>>> {
    const actual = await this.repository.get<Versioned<KeyValues<V>>>(
      this.tupleKey,
    );
    return ensureDocument(actual);
  }

  public async edit(
    modifier: (input: KeyValues<V>) => KeyValues<V>,
  ): Promise<Versioned<KeyValues<V>>> {
    const doc = await this.read();
    const newDoc = {
      content: modifier(doc.content),
      version: doc.version + 1,
    };
    await this.repository.set(this.tupleKey, newDoc);
    return newDoc;
  }

  public async view<U>(selector: (input: KeyValues<V>) => U): Promise<U> {
    return selector((await this.read()).content);
  }
}

function ensureDocument<V>(
  doc: Versioned<KeyValues<V>> | undefined,
): Versioned<KeyValues<V>> {
  return {
    version: doc?.version ? doc.version : 0,
    content: doc?.content ? doc.content : {},
  };
}
