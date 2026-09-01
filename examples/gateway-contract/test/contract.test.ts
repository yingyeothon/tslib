import type { GatewayCommand } from "@yingyeothon/lambda-gamebase";
import { describe, expect, it } from "vitest";
import { buildUserMessage, queueKeyFor } from "../src/envelope.js";
import {
  applyGatewayCommand,
  parseGatewayCommand,
  type GatewayFanOut,
} from "../src/gateway.js";
import { runContract } from "../src/main.js";

describe("gateway contract", () => {
  it("shows a bare payload arriving as undefined, with no error", async () => {
    const report = await runContract();

    expect(report.wrapped).toEqual([
      { type: "move", connectionId: "c1", x: 3 },
    ]);
    // The failure this example exists for: the push succeeded, the drain
    // succeeded, and the game got nothing.
    expect(report.bare).toEqual([undefined]);
  });

  it("puts no queue: segment in the key the actor drains", () => {
    expect(queueKeyFor("game:dev:demo:queue:", "g1")).toBe(
      "game:dev:demo:queue:g1",
    );
  });

  it("wraps a payload with a Forget policy, which is numeric zero", () => {
    const envelope = buildUserMessage({ type: "move" });
    // A gateway writing `"Forget"` here would be pushing an unreadable
    // envelope just as surely as pushing a bare payload.
    expect(envelope.awaitPolicy).toBe(0);
    expect(envelope.awaitTimeoutMillis).toBe(0);
    expect(envelope.messageId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("delivers both send shapes, and drops", () => {
    const fanOut: GatewayFanOut = { delivered: [], closed: [] };
    const commands: GatewayCommand[] = [
      { op: "send", connectionId: "c1", message: 1 },
      { op: "send", connectionIds: ["c1", "c2"], message: 2 },
      { op: "drop", connectionId: "c2" },
    ];
    for (const command of commands) applyGatewayCommand(command, fanOut);

    expect(fanOut.delivered).toEqual([
      { connectionIds: ["c1"], message: 1 },
      // The one a gateway branching on `op` alone loses entirely.
      { connectionIds: ["c1", "c2"], message: 2 },
    ]);
    expect(fanOut.closed).toEqual(["c2"]);
  });

  it("refuses a published frame that is not a command", () => {
    expect(parseGatewayCommand("not json")).toBeNull();
    expect(parseGatewayCommand('{"op":"explode"}')).toBeNull();
    expect(parseGatewayCommand("null")).toBeNull();
  });
});
