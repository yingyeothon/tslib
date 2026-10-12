import {
  createGameKit,
  type GameKit,
  type GameKitOptions,
} from "@yingyeothon/game-kit";
import { createFakePlatform } from "../../../test-support/platform-fakes.js";
import { createFakeScheduler } from "../../../test-support/game-kit-fakes.js";
/** Scenarios 5–10 use the same structural doubles as the package tests. */
export async function runExtendedGameKitDemo() {
  const scheduler = createFakeScheduler();
  const f = createFakePlatform(() => 1700000000000 + scheduler.now());
  f.state.collection("mail", "user", "project");
  f.board("weekly");
  const ids = ["a", "b", "c", "d"].map((x) => x.repeat(32));
  const kits: GameKit[] = [];
  const Socket = function (url: string, protocols: string[]) {
    return new (
      url.includes("match.invalid") ? f.MatchWebSocket : f.gateway.WebSocket
    )(url, protocols);
  } as unknown as NonNullable<GameKitOptions["WebSocket"]>;
  const drain = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  async function player(
    id: string,
    mode: "live" | "deferred",
    extra: Partial<GameKitOptions> = {},
  ) {
    const kit = createGameKit({
      config: {
        auth: { url: "https://auth.invalid", channelId: "auth" },
        state: { url: "https://state.invalid" },
        gateway: { url: "wss://gateway.invalid", lobbyChannelId: "lobby" },
        boards: { weekly: "weekly" },
        collections: { mail: "mail" },
        match:
          mode === "live"
            ? { url: "wss://match.invalid", channelId: "match" }
            : {
                mode: "deferred",
                apiBase: "https://match.invalid",
                channelId: "match",
                ticketUrl: "https://match.invalid/m/match/ticket",
              },
        push: {
          channelId: "push",
          apiBase: "https://state.invalid",
          topic: "configured.topic",
        },
      },
      fetch: f.fetch,
      WebSocket: Socket,
      scheduler,
      ...extra,
    });
    kits.push(kit);
    await kit.session.fromToken(f.register(id));
    return kit;
  }
  try {
    const players: GameKit[] = [];
    for (const id of ids) players.push(await player(id, "live"));
    const [a, b] = players as [GameKit, GameKit, ...GameKit[]];
    const scores = await (await a.board("weekly")).submit({ score: 42 });
    f.state.seed("mail", "gift", { coins: 5 }, ids[0]);
    const claims = await Promise.allSettled([
      a.mail.claim("gift"),
      a.mail.claim("gift"),
    ]);
    await a.friends.profile.set({ displayName: "Alice" });
    await b.friends.profile.set({ displayName: "Bob" });
    await a.friends.request(ids[1]!);
    await b.friends.accept(ids[0]!);
    f.online.add(ids[1]!);
    const friendOnline = (await a.friends.list())[0]!.online;
    for (const kit of players) kit.room.on("invited", () => {});
    await drain();
    const matches = players.map((kit) => kit.matchmaking.find());
    f.match(ids);
    await Promise.all(matches);
    const matchedMembers = a.room.members.length;
    for (const kit of players) kit.dispose();
    const topics: string[] = [];
    const da = await player(ids[0]!, "deferred", {
      push: {
        topics: {
          subscribe: (topic) => {
            topics.push(topic);
            return Promise.resolve();
          },
          unsubscribe: (topic) => {
            topics.splice(topics.indexOf(topic), 1);
            return Promise.resolve();
          },
        },
      },
    });
    const db = await player(ids[1]!, "deferred");
    await da.matchmaking.submit();
    await db.matchmaking.submit();
    await da.matchmaking.accept();
    await db.matchmaking.accept();
    const confirmed = await da.matchmaking.status();
    await da.push.register({
      token: "fake-fcm-token",
      project: "firebase-project",
    });
    const subscribed = topics[0];
    da.push.classify({
      data: {
        channelId: "match",
        matchId: String(confirmed?.matchId),
        state: "confirmed",
      },
    });
    await da.session.signOut();
    return {
      periods: scores.length,
      mailClaims: claims.filter((r) => r.status === "fulfilled").length,
      friendOnline,
      matchedMembers,
      deferredState: confirmed?.state,
      subscribed,
      tokensAfterSignOut: f.pushes.size,
    };
  } finally {
    for (const kit of kits) {
      await kit.session.signOut();
      kit.dispose();
    }
  }
}
