import { describe, expect, it } from "vitest";
import { createTextMatch, withMatch } from "../src/index.js";

describe("TextMatch", () => {
  it("captures fragments delimited by end marks", () => {
    const m = createTextMatch("abc\r\ndef\r\n").capture("\r\n").capture("\r\n");
    expect(m.values()).toEqual(["abc", "def"]);
    expect(m.evaluate()).toBe(10);
  });

  it("fails when an end mark is missing", () => {
    const m = createTextMatch("abc\r\ndef").capture("\r\n").capture("\r\n");
    expect(m.evaluate()).toBe(-1);
  });

  it("stops capturing after the first failure", () => {
    const m = createTextMatch("abc").capture("|").capture("|");
    expect(m.values()).toEqual([]);
    expect(m.evaluate()).toBe(-1);
  });

  it("returns a copy of captured values", () => {
    const m = createTextMatch("a|b|").capture("|");
    const first = m.values();
    first.push("mutated");
    expect(m.values()).toEqual(["a"]);
  });
});

describe("withMatch", () => {
  it("turns a match chain into a fulfill function", () => {
    const fulfill = withMatch((m) => m.capture("\r\n").capture("\r\n"));
    expect(fulfill("+OK\r\n")).toBe(-1);
    expect(fulfill("+OK\r\n$5\r\n")).toBe(9);
    expect(fulfill("+OK\r\n$5\r\ntrailing")).toBe(9);
  });
});
