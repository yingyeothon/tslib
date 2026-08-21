import { describe, expect, it } from "vitest";
import { incompletePushFrame, parsePushFrame } from "../src/index.js";

function bulk(value: string): string {
  return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

function messageFrame(channel: string, payload: string): string {
  return `*3\r\n${bulk("message")}${bulk(channel)}${bulk(payload)}`;
}

function subscriptionFrame(
  event: "subscribe" | "unsubscribe",
  channel: string,
  count: number,
): string {
  return `*3\r\n${bulk(event)}${bulk(channel)}:${count}\r\n`;
}

describe("parsePushFrame", () => {
  it("parses a message frame", () => {
    const frame = messageFrame("room", "hello");
    expect(parsePushFrame(frame)).toEqual({
      consumed: frame.length,
      frame: { kind: "message", channel: "room", payload: "hello" },
    });
  });

  it("parses subscribe and unsubscribe confirmations", () => {
    expect(
      parsePushFrame(subscriptionFrame("subscribe", "room", 1)).frame,
    ).toEqual({
      kind: "subscription",
      event: "subscribe",
      channel: "room",
      count: 1,
    });
    expect(
      parsePushFrame(subscriptionFrame("unsubscribe", "room", 0)).frame,
    ).toEqual({
      kind: "subscription",
      event: "unsubscribe",
      channel: "room",
      count: 0,
    });
  });

  it("reports every partial prefix as incomplete", () => {
    const frame = messageFrame("room", "hello");
    for (let length = 0; length < frame.length; ++length) {
      expect(parsePushFrame(frame.slice(0, length)).consumed).toBe(
        incompletePushFrame,
      );
    }
  });

  it("keeps a payload that contains the frame delimiter", () => {
    const payload = "line-one\r\nline-two\r\n";
    const result = parsePushFrame(messageFrame("room", payload));
    expect(result.frame).toEqual({ kind: "message", channel: "room", payload });
  });

  it("resolves a multi-byte payload by byte length", () => {
    const payload = "안녕하세요";
    const frame = messageFrame("방", payload);
    // The declared lengths are byte counts, not character counts.
    expect(frame).toContain(`$${Buffer.byteLength(payload)}\r\n`);
    expect(parsePushFrame(frame)).toEqual({
      consumed: frame.length,
      frame: { kind: "message", channel: "방", payload },
    });
  });

  it("resolves a two-byte payload by byte length", () => {
    // Latin-1/Greek/Cyrillic take the 2-byte branch of the length walk.
    const payload = "café Ωμέγα Привет";
    const result = parsePushFrame(messageFrame("room", payload));
    expect(result.frame).toEqual({ kind: "message", channel: "room", payload });
  });

  it("resolves a surrogate-pair payload by byte length", () => {
    const payload = "🎮🎲";
    const result = parsePushFrame(messageFrame("room", payload));
    expect(result.frame).toEqual({ kind: "message", channel: "room", payload });
  });

  it("consumes only the first of several buffered frames", () => {
    const first = messageFrame("room", "one");
    const second = messageFrame("room", "two");
    const result = parsePushFrame(first + second);
    expect(result.consumed).toBe(first.length);
    expect(
      parsePushFrame((first + second).slice(result.consumed)).frame,
    ).toEqual({ kind: "message", channel: "room", payload: "two" });
  });

  it("treats a null bulk element as an unknown frame", () => {
    const frame = `*3\r\n${bulk("message")}$-1\r\n${bulk("payload")}`;
    expect(parsePushFrame(frame)).toEqual({
      consumed: frame.length,
      frame: { kind: "other" },
    });
  });

  it("consumes a single-line reply as an unknown frame", () => {
    expect(parsePushFrame("-ERR unknown command\r\n")).toEqual({
      consumed: "-ERR unknown command\r\n".length,
      frame: { kind: "other" },
    });
    // A stray blank line must be consumed rather than block the stream.
    expect(parsePushFrame("\r\n")).toEqual({
      consumed: 2,
      frame: { kind: "other" },
    });
  });

  it("consumes a negative array as an unknown frame", () => {
    expect(parsePushFrame("*-1\r\n")).toEqual({
      consumed: 5,
      frame: { kind: "other" },
    });
  });

  it("does not claim a pattern message", () => {
    const frame = `*4\r\n${bulk("pmessage")}${bulk("ro*")}${bulk("room")}${bulk("hi")}`;
    expect(parsePushFrame(frame)).toEqual({
      consumed: frame.length,
      frame: { kind: "other" },
    });
  });

  it("throws on a malformed header", () => {
    expect(() => parsePushFrame("*x\r\n")).toThrow(/Invalid RESP array header/);
    expect(() => parsePushFrame(`*1\r\n$x\r\nab\r\n`)).toThrow(
      /Invalid RESP bulk header/,
    );
  });

  it("throws when a bulk length splits a character", () => {
    // "가" is three bytes, so a two-byte bulk cannot end on its boundary.
    expect(() => parsePushFrame(`*1\r\n$2\r\n가\r\n`)).toThrow(
      /does not end on a character boundary/,
    );
  });
});
