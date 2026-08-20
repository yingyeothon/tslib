import { describe, expect, it, vi } from "vitest";
import {
  clearActorStartEvent,
  loadActorStartEvent,
  saveActorStartEvent,
  type GameActorStartEvent,
} from "../src/index.js";

const event: GameActorStartEvent = {
  gameId: "game-1",
  members: [{ memberId: "m1", name: "one", email: "one@yyt.life" }],
};

describe("saveActorStartEvent", () => {
  it("stores the event as JSON under the prefixed key", async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    expect(
      await saveActorStartEvent({ event, set, eventKeyPrefix: "event:" }),
    ).toBe(true);
    expect(set).toHaveBeenCalledWith("event:game-1", JSON.stringify(event));
  });

  it("refuses an event without gameId", async () => {
    const set = vi.fn();
    expect(
      await saveActorStartEvent({
        event: { ...event, gameId: "" },
        set,
        eventKeyPrefix: "event:",
      }),
    ).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });
});

describe("loadActorStartEvent", () => {
  it("loads a stored event", async () => {
    const get = vi.fn().mockResolvedValue(JSON.stringify(event));
    expect(
      await loadActorStartEvent({
        gameId: "game-1",
        get,
        eventKeyPrefix: "event:",
      }),
    ).toEqual(event);
    expect(get).toHaveBeenCalledWith("event:game-1");
  });

  it("returns null for a missing key", async () => {
    const get = vi.fn().mockResolvedValue(null);
    expect(
      await loadActorStartEvent({
        gameId: "game-1",
        get,
        eventKeyPrefix: "event:",
      }),
    ).toBeNull();
  });

  it("returns null for malformed JSON", async () => {
    const get = vi.fn().mockResolvedValue("{not-json");
    expect(
      await loadActorStartEvent({
        gameId: "game-1",
        get,
        eventKeyPrefix: "event:",
      }),
    ).toBeNull();
  });

  it("returns null for an event without gameId", async () => {
    const get = vi.fn().mockResolvedValue(JSON.stringify({ members: [] }));
    expect(
      await loadActorStartEvent({
        gameId: "game-1",
        get,
        eventKeyPrefix: "event:",
      }),
    ).toBeNull();
  });
});

describe("clearActorStartEvent", () => {
  it("deletes the prefixed key", async () => {
    const del = vi.fn().mockResolvedValue(1);
    await clearActorStartEvent({
      gameId: "game-1",
      del,
      eventKeyPrefix: "event:",
    });
    expect(del).toHaveBeenCalledWith("event:game-1");
  });
});
