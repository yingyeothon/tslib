import type { Codec } from "./types.js";

const UNDEFINED = "undefined";

export const jsonCodec: Codec<string> = {
  encode<T>(item: T): string {
    if (item === undefined) {
      return UNDEFINED;
    }
    return JSON.stringify(item);
  },
  decode<T>(value: string): T {
    if (value === undefined) {
      throw new Error(`Value cannot be undefined`);
    }
    return JSON.parse(value) as T;
  },
};
