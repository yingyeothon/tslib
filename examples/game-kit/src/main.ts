import { pathToFileURL } from "node:url";
import { createGameKit, type RoomInvitation } from "@yingyeothon/game-kit";
import {
  createFakeState,
  createFakeScheduler,
  createFakeGameGateway,
} from "../../../test-support/game-kit-fakes.js";

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("demo state did not arrive");
}
export async function runGameKitDemo() {
  const scheduler = createFakeScheduler();
  const server = createFakeState({
    now: () => 1700000000000 + scheduler.now(),
  });
  const gateway = createFakeGameGateway();
  server.collection("save", "user", "user");
  server.collection("content", "project", "server");
  server.seed("content", "tuning", { speed: 2 });
  const config = {
    auth: { url: "https://auth.invalid", channelId: "ch_demo" },
    state: { url: "https://state.invalid" },
    gateway: { url: "wss://gateway.invalid", lobbyChannelId: "ch_demo" },
    collections: { save: "save", content: "content" },
  };
  const aliceToken = server.register("alice", 1700000610);
  const bobToken = server.register("bob", 1700000610);
  gateway.register("alice", aliceToken);
  gateway.register("bob", bobToken);
  const alice = createGameKit({
    config,
    fetch: server.fetch,
    WebSocket: gateway.WebSocket,
    scheduler,
  });
  const bob = createGameKit({
    config,
    fetch: server.fetch,
    WebSocket: gateway.WebSocket,
    scheduler,
  });
  const writer = createGameKit({ config, fetch: server.fetch, scheduler });
  try {
    let warnings = 0;
    alice.session.on("expiring", () => {
      warnings++;
    });
    await alice.session.fromToken(aliceToken);
    await bob.session.fromToken(bobToken);
    await writer.session.fromToken(aliceToken);
    scheduler.advance(10000);
    const tuning = await alice.content.get("tuning");
    await alice.save.load("settings");
    await writer.save.load("settings");
    await alice.save.store("settings", { volume: 1 });
    await writer.save.store(
      "settings",
      { speed: 2 },
      {
        merge: (local, remote) => ({
          ...(remote as object),
          ...(local as object),
        }),
      },
    );
    const claim = [
      await alice.save.claimOnce("daily", 60),
      await writer.save.claimOnce("daily", 60),
    ];
    const wallet = await alice.save.counter("wallet").add(3, { min: 0 });
    const invited = new Promise<RoomInvitation>((resolve) => {
      bob.room.on("invited", resolve);
    });
    await alice.room.create();
    await alice.room.invite("bob");
    await (await invited).accept();
    await alice.room.state.publish({ hp: 10 });
    const options = {
      initial: 0,
      players: ["alice", "bob"],
      apply: (state: number, move: number) => state + move,
    };
    const aGame = alice.turns.start({ ...options, room: alice.room });
    const bGame = bob.turns.start({ ...options, room: bob.room });
    await aGame.submit(1);
    await waitFor(() => bGame.index === 1);
    await bGame.submit(2);
    await waitFor(() => aGame.index === 2);
    const result = {
      warnings,
      now: alice.session.now(),
      tuning,
      settings: await alice.save.load("settings"),
      claim,
      wallet,
      members: bob.room.members.length,
      finalState: [aGame.state, bGame.state],
    };
    let inherited: unknown;
    bob.room.becomeHost((event) => {
      inherited = event.lastKnown;
    });
    await alice.room.leave();
    await waitFor(() => bob.room.isHost);
    return { ...result, inherited };
  } finally {
    alice.dispose();
    bob.dispose();
    writer.dispose();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.log(JSON.stringify(await runGameKitDemo(), null, 2));
}
