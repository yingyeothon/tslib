import { describe, expect, it } from "vitest";
import { JsonCodec, type Codec } from "../src/index.js";

interface Context {
  a: number;
  b: string;
  c: {
    d: number;
    e: string;
  };
}

describe("JsonCodec", () => {
  it("round-trips a nested object", () => {
    const ctx: Context = {
      a: 10,
      b: "hello",
      c: {
        d: 20,
        e: "world",
      },
    };
    const codec = new JsonCodec();
    expect(codec.decode<Context>(codec.encode(ctx))).toEqual(ctx);
  });

  it("round-trips primitives, arrays and null", () => {
    const codec = new JsonCodec();
    expect(codec.decode<number>(codec.encode(42))).toBe(42);
    expect(codec.decode<string>(codec.encode("text"))).toBe("text");
    expect(codec.decode<boolean>(codec.encode(false))).toBe(false);
    expect(codec.decode<null>(codec.encode(null))).toBeNull();
    expect(codec.decode<number[]>(codec.encode([1, 2, 3]))).toEqual([1, 2, 3]);
  });

  it('encodes undefined as the literal string "undefined"', () => {
    const codec = new JsonCodec();
    expect(codec.encode(undefined)).toBe("undefined");
  });

  it("throws when decoding undefined", () => {
    const codec = new JsonCodec();
    expect(() => codec.decode(undefined as unknown as string)).toThrow(
      "Value cannot be undefined",
    );
  });

  it("throws when decoding invalid JSON", () => {
    const codec = new JsonCodec();
    expect(() => codec.decode("not-json")).toThrow(SyntaxError);
    expect(() => codec.decode("undefined")).toThrow(SyntaxError);
  });

  it("is usable through the Codec<string> interface", () => {
    const codec: Codec<string> = new JsonCodec();
    expect(codec.decode<{ x: number }>(codec.encode({ x: 1 }))).toEqual({
      x: 1,
    });
  });
});
