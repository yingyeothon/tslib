import {
  GatewayCloseCode,
  classifyClose,
  createGatewayGameClient,
  createGatewayLobbyClient,
  type Hello,
} from "@yingyeothon/gamebase-client";
import { createFakeWebSocketFactory, flush } from "./fake-web-socket.js";

const url = "wss://gw.yyt.life";
const token = "a.channel.jwt";

const hello: Hello = {
  type: "hello",
  userId: "u1",
  connectionId: "conn-1",
  tick: 200,
  mapUrl: "",
  zone: "town",
  // `say` is the list of scopes the channel enables, not a boolean. The SDK
  // mirrors the gateway's Go structs, so a wrong type here is a wrong frame.
  capabilities: { pos: true, say: ["zone", "party", "user"], party: true },
};

export interface LobbyReport {
  /** What the SDK asked for on the wire. */
  requestedUrl: string;
  /** The credential travels here, never in the URL. */
  protocols: string[];
  /** `connect()` resolves on `hello`, not on the socket opening. */
  helloZone: string;
  /** The peer map, after a snapshot and one move. */
  peers: { userId: string; x: number; y: number }[];
}

export async function runLobby(): Promise<LobbyReport> {
  const factory = createFakeWebSocketFactory();
  const lobby = createGatewayLobbyClient({
    url,
    channelId: "lobby_demo",
    token,
    WebSocket: factory.WebSocket,
  });

  const connected = lobby.connect();
  const socket = factory.latest();
  socket.serverOpen("bearer");
  // Nothing is "connected" before `hello`: it is the only delivery path for
  // the channel's capabilities and its map pointer.
  socket.serverSend(hello);
  const arrived = await connected;

  socket.serverSend({
    type: "snapshot",
    zone: "town",
    peers: [{ userId: "u2", zone: "town", x: 1, y: 1, dir: "n" }],
  });
  // `zone` is required on the frame, not just on each peer: frames for another
  // zone are ignored, so a `pos` without one never reaches the map.
  socket.serverSend({
    type: "pos",
    zone: "town",
    peers: [{ userId: "u2", zone: "town", x: 4, y: 1, dir: "e" }],
  });

  const peers = lobby.peers.all().map((peer) => ({
    userId: peer.userId,
    x: peer.x,
    y: peer.y,
  }));
  lobby.close();
  await flush();

  return {
    requestedUrl: socket.url,
    protocols: socket.protocols,
    helloZone: arrived.zone,
    peers,
  };
}

export interface RunEnding {
  code: number;
  /** What `classifyClose` says a client should do about it. */
  disposition: string;
  /** The event the SDK actually raised. */
  event: "finished" | "aborted" | "stopped" | "none";
}

/** Plays one dungeon run and closes it with `code`. */
export async function runDungeon(code: number): Promise<RunEnding> {
  const factory = createFakeWebSocketFactory();
  const game = createGatewayGameClient({
    url,
    channelId: "q_demo",
    gameId: "run-1",
    token,
    WebSocket: factory.WebSocket,
    // A closed run must not be retried forever; one attempt is enough here.
    backoff: { maxAttempts: 0 },
  });

  let event: RunEnding["event"] = "none";
  game.on("finished", () => {
    event = "finished";
  });
  game.on("aborted", () => {
    event = "aborted";
  });
  game.on("stopped", () => {
    if (event === "none") event = "stopped";
  });

  const connected = game.connect();
  const socket = factory.latest();
  // A `q` channel has no `hello`, so `connect()` resolves on the open itself.
  socket.serverOpen("bearer");
  await connected;

  // The frames are the game's own schema; the gateway never reads them.
  game.send({ type: "attack", power: 3 });
  socket.serverSend({ type: "snapshot", bossHp: 8 });

  socket.serverClose(code);
  await flush();

  return {
    code,
    disposition: classifyClose(code, "q").kind,
    event,
  };
}

export async function main(): Promise<void> {
  const lobby = await runLobby();
  console.log(`lobby url:        ${lobby.requestedUrl}`);
  console.log(`subprotocols:     ${JSON.stringify(lobby.protocols)}`);
  console.log("  ^ the JWT rides here, never in the URL, and is never logged");
  console.log(`connect() gave:   zone=${lobby.helloZone}`);
  console.log(`peers after move: ${JSON.stringify(lobby.peers)}`);

  console.log("\nhow a dungeon run ends:");
  for (const code of [1000, GatewayCloseCode.aborted]) {
    const ending = await runDungeon(code);
    console.log(
      `  close ${ending.code} -> ${ending.disposition.padEnd(9)} ` +
        `event=${ending.event}`,
    );
  }
  console.log("  1000 finished the run; 4001 means the actor died and a retry");
  console.log("  needs a NEW gameId — the old queue key is gone. Neither");
  console.log("  reconnects; every other code does, with backoff.");
}

if (process.argv[1]?.endsWith("main.ts")) {
  await main();
}
