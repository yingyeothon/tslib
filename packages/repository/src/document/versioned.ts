export interface Versioned<T> {
  version: number;
  content: T;
}
