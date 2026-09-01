import { describe, expect, it } from "vitest";
import { runGame } from "../src/main.js";

const typesOf = (frames: { message: unknown }[]) =>
  frames.map((frame) => (frame.message as { type: string }).type);

describe("actor-game example", () => {
  it("plays a whole game through handleActor with no Redis", async () => {
    const { transport, bossHp, cleared } = await runGame();

    expect(cleared).toBe(true);
    expect(bossHp).toBe(0);

    const types = typesOf(transport.frames);
    // Each member is resynchronised on entry before anything else happens.
    expect(types.slice(0, 2)).toEqual(["snapshot", "snapshot"]);
    // Six attacks at 2 damage against 12 hit points.
    expect(types.filter((type) => type === "hit")).toHaveLength(6);

    const result = transport.frames.find(
      (frame) => (frame.message as { type: string }).type === "result",
    )?.message as {
      payload: { reason: string; damage: Record<string, number> };
    };
    expect(result.payload.reason).toBe("cleared");
    expect(result.payload.damage).toEqual({ m1: 6, m2: 6 });

    // Ordering is the behaviour, so assert the interleaving rather than two
    // counts: every send must precede every drop, or the party's sockets close
    // before they learn how the raid ended.
    const firstDrop = transport.events.findIndex((e) => e.startsWith("drop:"));
    const lastSend = transport.events.findLastIndex((e) =>
      e.startsWith("send:"),
    );
    expect(firstDrop).toBeGreaterThan(lastSend);
    expect(transport.events).toContain("send:result");
    expect(transport.dropped.sort()).toEqual(["local:m1", "local:m2"]);
  });
});
