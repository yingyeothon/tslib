import { describe, expect, it } from "vitest";
import { createPeerMap } from "../src/index.js";

function setup() {
  const peers = createPeerMap({ selfUserId: "me" });
  peers.apply({
    type: "snapshot",
    zone: "town",
    peers: [
      { userId: "me", x: 0, y: 0 },
      { userId: "bob", x: 1, y: 1 },
    ],
  });
  return peers;
}

describe("createPeerMap", () => {
  it("snapshot replaces everything and drops self", () => {
    const peers = setup();
    expect(peers.zone).toBe("town");
    expect(peers.all()).toEqual([{ userId: "bob", x: 1, y: 1 }]);
    const change = peers.apply({
      type: "snapshot",
      zone: "field",
      peers: [{ userId: "carol", x: 5, y: 5, dir: 2 }],
    });
    expect(change).toEqual({
      kind: "snapshot",
      zone: "field",
      peers: [{ userId: "carol", x: 5, y: 5, dir: 2 }],
    });
    expect(peers.get("bob")).toBeUndefined();
  });

  it("ignores every frame before the first snapshot", () => {
    const peers = createPeerMap({ selfUserId: "me" });
    expect(
      peers.apply({ type: "enter", zone: "town", userId: "bob", x: 1, y: 1 }),
    ).toBeUndefined();
    expect(peers.all()).toEqual([]);
  });

  it("enter upserts and leave removes", () => {
    const peers = setup();
    expect(
      peers.apply({
        type: "enter",
        zone: "town",
        userId: "carol",
        x: 2,
        y: 3,
        dir: 1,
      }),
    ).toEqual({ kind: "enter", peer: { userId: "carol", x: 2, y: 3, dir: 1 } });
    expect(
      peers.apply({ type: "leave", zone: "town", userId: "carol" }),
    ).toEqual({
      kind: "leave",
      userId: "carol",
    });
    expect(peers.get("carol")).toBeUndefined();
    expect(
      peers.apply({ type: "leave", zone: "town", userId: "carol" }),
    ).toBeUndefined();
  });

  it("does not resurrect a peer that left when a late pos names it", () => {
    const peers = setup();
    peers.apply({ type: "leave", zone: "town", userId: "bob" });
    const change = peers.apply({
      type: "pos",
      zone: "town",
      peers: [{ userId: "bob", x: 9, y: 9 }],
    });
    expect(change).toBeUndefined();
    expect(peers.all()).toEqual([]);
  });

  it("pos updates known peers only and filters self", () => {
    const peers = setup();
    const change = peers.apply({
      type: "pos",
      zone: "town",
      peers: [
        { userId: "me", x: 7, y: 7 },
        { userId: "bob", x: 2, y: 2, dir: 3 },
        { userId: "ghost", x: 0, y: 0 },
      ],
    });
    expect(change).toEqual({
      kind: "move",
      peers: [{ userId: "bob", x: 2, y: 2, dir: 3 }],
    });
    expect(peers.get("me")).toBeUndefined();
    expect(peers.get("ghost")).toBeUndefined();
  });

  it("keeps the previous dir when a pos update omits it", () => {
    const peers = setup();
    peers.apply({
      type: "enter",
      zone: "town",
      userId: "carol",
      x: 0,
      y: 0,
      dir: 4,
    });
    peers.apply({
      type: "pos",
      zone: "town",
      peers: [{ userId: "carol", x: 1, y: 0 }],
    });
    expect(peers.get("carol")).toEqual({ userId: "carol", x: 1, y: 0, dir: 4 });
  });

  it("ignores frames for another zone", () => {
    const peers = setup();
    expect(
      peers.apply({
        type: "enter",
        zone: "field",
        userId: "carol",
        x: 0,
        y: 0,
      }),
    ).toBeUndefined();
    expect(
      peers.apply({ type: "leave", zone: "field", userId: "bob" }),
    ).toBeUndefined();
    expect(peers.get("bob")).toEqual({ userId: "bob", x: 1, y: 1 });
  });

  it("returns copies, so callers cannot mutate the map", () => {
    const peers = setup();
    const bob = peers.get("bob");
    if (bob === undefined) {
      throw new Error("bob missing");
    }
    bob.x = 99;
    expect(peers.get("bob")?.x).toBe(1);
  });

  it("reset() forgets the zone and the peers", () => {
    const peers = setup();
    peers.reset();
    expect(peers.zone).toBeUndefined();
    expect(peers.all()).toEqual([]);
  });
});
