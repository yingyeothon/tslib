import { describe, expect, it } from "vitest";
import { jsonCodec, type Codec } from "../src/index.js";

interface Context {
  a: number;
  b: string;
  c: {
    d: number;
    e: string;
  };
}

describe("jsonCodec", () => {
  it("round-trips a nested object", () => {
    const ctx: Context = {
      a: 10,
      b: "hello",
      c: {
        d: 20,
        e: "world",
      },
    };
    expect(jsonCodec.decode<Context>(jsonCodec.encode(ctx))).toEqual(ctx);
  });

  it("round-trips primitives, arrays and null", () => {
    expect(jsonCodec.decode<number>(jsonCodec.encode(42))).toBe(42);
    expect(jsonCodec.decode<string>(jsonCodec.encode("text"))).toBe("text");
    expect(jsonCodec.decode<boolean>(jsonCodec.encode(false))).toBe(false);
    expect(jsonCodec.decode<null>(jsonCodec.encode(null))).toBeNull();
    expect(jsonCodec.decode<number[]>(jsonCodec.encode([1, 2, 3]))).toEqual([
      1, 2, 3,
    ]);
  });

  it('encodes undefined as the literal string "undefined"', () => {
    expect(jsonCodec.encode(undefined)).toBe("undefined");
  });

  it("throws when decoding undefined", () => {
    expect(() => jsonCodec.decode(undefined as unknown as string)).toThrow(
      "Value cannot be undefined",
    );
  });

  it("throws when decoding invalid JSON", () => {
    expect(() => jsonCodec.decode("not-json")).toThrow(SyntaxError);
    expect(() => jsonCodec.decode("undefined")).toThrow(SyntaxError);
  });

  it("is usable through the Codec<string> interface", () => {
    const codec: Codec<string> = jsonCodec;
    expect(codec.decode<{ x: number }>(codec.encode({ x: 1 }))).toEqual({
      x: 1,
    });
  });
});
