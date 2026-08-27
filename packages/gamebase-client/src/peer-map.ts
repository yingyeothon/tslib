import type {
  EnterFrame,
  LeaveFrame,
  Peer,
  PosBroadcastFrame,
  SnapshotFrame,
} from "./types.js";

export type PeerMapFrame =
  SnapshotFrame | EnterFrame | LeaveFrame | PosBroadcastFrame;

export type PeerChange =
  | { kind: "snapshot"; zone: string; peers: Peer[] }
  | { kind: "enter"; peer: Peer }
  | { kind: "leave"; userId: string }
  | { kind: "move"; peers: Peer[] };

export interface PeerMapOptions {
  /** The receiver's own userId; its entry in `pos` broadcasts is dropped. */
  selfUserId: string;
}

export interface PeerMap {
  /** The zone of the last `snapshot`, or `undefined` before one arrives. */
  readonly zone: string | undefined;
  /** Applies one frame; returns the change it produced, or `undefined` when ignored. */
  apply(frame: PeerMapFrame): PeerChange | undefined;
  get(userId: string): Peer | undefined;
  all(): Peer[];
  reset(): void;
}

/**
 * Reduces the gateway's `snapshot` / `enter` / `leave` / `pos` frames into the
 * set of peers visible in the current zone. A `snapshot` replaces everything
 * (that is how a zone change starts); frames for any other zone are ignored so
 * a late `pos` from the old zone cannot resurrect a peer that already left.
 */
export function createPeerMap(options: PeerMapOptions): PeerMap {
  const { selfUserId } = options;
  const peers = new Map<string, Peer>();
  let zone: string | undefined;

  function copy(peer: Peer): Peer {
    return { ...peer };
  }

  return {
    get zone() {
      return zone;
    },
    apply(frame) {
      if (frame.type === "snapshot") {
        zone = frame.zone;
        peers.clear();
        for (const peer of frame.peers) {
          if (peer.userId !== selfUserId) {
            peers.set(peer.userId, copy(peer));
          }
        }
        return { kind: "snapshot", zone, peers: this.all() };
      }
      if (zone === undefined || frame.zone !== zone) {
        return undefined;
      }
      switch (frame.type) {
        case "enter": {
          if (frame.userId === selfUserId) {
            return undefined;
          }
          const peer: Peer = {
            userId: frame.userId,
            x: frame.x,
            y: frame.y,
            ...(frame.dir === undefined ? {} : { dir: frame.dir }),
          };
          peers.set(peer.userId, peer);
          return { kind: "enter", peer: copy(peer) };
        }
        case "leave": {
          if (!peers.delete(frame.userId)) {
            return undefined;
          }
          return { kind: "leave", userId: frame.userId };
        }
        case "pos": {
          const moved: Peer[] = [];
          for (const update of frame.peers) {
            if (update.userId === selfUserId) {
              continue;
            }
            const existing = peers.get(update.userId);
            if (existing === undefined) {
              continue;
            }
            existing.x = update.x;
            existing.y = update.y;
            if (update.dir !== undefined) {
              existing.dir = update.dir;
            }
            moved.push(copy(existing));
          }
          return moved.length === 0
            ? undefined
            : { kind: "move", peers: moved };
        }
      }
    },
    get(userId) {
      const peer = peers.get(userId);
      return peer === undefined ? undefined : copy(peer);
    },
    all() {
      return [...peers.values()].map(copy);
    },
    reset() {
      peers.clear();
      zone = undefined;
    },
  };
}
