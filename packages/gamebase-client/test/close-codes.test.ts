import { describe, expect, it } from "vitest";
import { classifyClose, GatewayCloseCode } from "../src/index.js";

describe("classifyClose", () => {
  it.each([
    [4000, "lobby", "stop"],
    [4000, "q", "stop"],
    [4001, "lobby", "stop"],
    [4001, "q", "aborted"],
    [4002, "lobby", "reconnect"],
    [4002, "q", "reconnect"],
    [4003, "lobby", "clientBug"],
    [4003, "q", "clientBug"],
    [4004, "lobby", "stop"],
    [4004, "q", "stop"],
    [1000, "lobby", "stop"],
    [1000, "q", "finished"],
    [1001, "lobby", "reconnect"],
    [1001, "q", "reconnect"],
    [1003, "q", "clientBug"],
    [1006, "lobby", "reconnect"],
    [1009, "lobby", "clientBug"],
    [1011, "q", "reconnect"],
    [4999, "q", "reconnect"],
  ] as const)("maps %d on %s to %s", (code, kind, expected) => {
    expect(classifyClose(code, kind).kind).toBe(expected);
  });

  it("never reconnects an aborted or finished run", () => {
    expect(classifyClose(GatewayCloseCode.aborted, "q").kind).not.toBe(
      "reconnect",
    );
    expect(classifyClose(1000, "q").kind).not.toBe("reconnect");
  });

  it("exposes the documented application codes", () => {
    expect(GatewayCloseCode).toEqual({
      replaced: 4000,
      aborted: 4001,
      idle: 4002,
      policy: 4003,
      channelGone: 4004,
    });
  });
});
