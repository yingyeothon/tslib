export interface Codec<B> {
  encode<T>(item: T): B;
  decode<T>(value: B): T;
}
