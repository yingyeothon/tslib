import {
  createInMemoryLock,
  createInMemoryQueue,
  enqueue,
} from "@yingyeothon/actor-system";
import { runGameAllTogether } from "@yingyeothon/gamebase-all-together";
import {
  broadcast,
  handleActor,
  reply,
  sleep,
  type GameActorStartEvent,
} from "@yingyeothon/lambda-gamebase";
import { nullLogger } from "@yingyeothon/logger";
import {
  applyHit,
  createRaid,
  isCleared,
  snapshot,
  type AttackMessage,
} from "./game.js";
import {
  createRecordingTransport,
  type RecordingTransport,
} from "./transport.js";

/** `enter` and `leave` are the framework's; `attack` is this game's. */
type Message =
  | AttackMessage
  | { type: "enter" | "leave"; connectionId: string; memberId: string };

const members = [
  { memberId: "m1", name: "Ari", email: "ari@example.test" },
  { memberId: "m2", name: "Bo", email: "bo@example.test" },
];

/** One connection per member, exactly as `handleConnect` would produce. */
const connectionIdOf = (memberId: string) => `local:${memberId}`;

export interface GameOutcome {
  transport: RecordingTransport;
  bossHp: number;
  cleared: boolean;
}

/**
 * Runs one whole game through the real `handleActor`.
 *
 * Nothing here is a stand-in for the entry point: this is the function a
 * Lambda calls. What is swapped out is only what it talks to — an in-memory
 * queue and lock instead of Redis, a recording transport instead of API
 * Gateway, and the two start-event hooks instead of `redisSet`/`redisDel`.
 */
export async function runGame(
  print: (line: string) => void = () => undefined,
): Promise<GameOutcome> {
  const queue = createInMemoryQueue();
  const transport = createRecordingTransport(print);
  const startEvents = new Map<string, string>();
  const raid = createRaid(12);

  const event: GameActorStartEvent = { gameId: "raid-1", members };

  // The gateway pushes these; here we seed the queue directly. The envelope
  // matters more than it looks — see examples/gateway-contract.
  const producer = { id: event.gameId, queue, logger: nullLogger };
  for (const member of members) {
    await enqueue<Message>(producer, {
      item: {
        type: "enter",
        connectionId: connectionIdOf(member.memberId),
        memberId: member.memberId,
      },
    });
  }

  /**
   * Attacks arrive *while the game runs*, because that is when a client can
   * send them. Queueing them up front instead looks like it should work and
   * does not: the wait stage drains the queue looking for `enter`/`leave` and
   * discards everything else, so the raid would end on `timeout` with nobody
   * having hit anything.
   */
  const players = async () => {
    for (let i = 0; i < 6; i += 1) {
      await sleep(20);
      const member = members[i % members.length];
      if (!member) continue;
      await enqueue<Message>(producer, {
        item: {
          type: "attack",
          connectionId: connectionIdOf(member.memberId),
          power: 2,
        },
      });
    }
  };

  const actor = handleActor<Message>({
    event,
    eventKeyPrefix: "game:event:",
    awaiterKeyPrefix: "game:awaiter:",
    queueKeyPrefix: "game:queue:",
    lockKeyPrefix: "game:lock:",
    lifetimeSeconds: 30,
    // No redisConnection and no context: the three things one would be used
    // for are all supplied below, so none is needed.
    subsystem: { queue, lock: createInMemoryLock(), logger: nullLogger },
    saveStartEvent: (key, value) => {
      startEvents.set(key, value);
      return Promise.resolve(true);
    },
    deleteStartEvent: (key) => {
      startEvents.delete(key);
      return Promise.resolve(1);
    },
    gameMain: (options) =>
      runGameAllTogether<Message>({
        ...options,
        network: { transport },
        // Everyone is already queued, so the wait stage ends at once.
        gameWaitingSeconds: 5,
        gameRunningSeconds: 5,
        pollIntervalMillis: 10,
        // Turn-based: nothing moves unless somebody acts. A real-time game
        // wants `{ mode: "fixed", intervalMillis: 50 }` instead, or monsters
        // freeze whenever the party stands still.
        tick: { mode: "perMessage" },
        isGameOver: () => isCleared(raid),
        processMessage: async ({ context, message }) => {
          if (message.type !== "attack") return;
          const user = context.connectedUsers[message.connectionId];
          if (!user) return; // an unbound connection speaks for nobody
          const dealt = applyHit(raid, user.memberId, message.power);
          await broadcast(
            Object.keys(context.connectedUsers),
            { type: "hit", payload: { memberId: user.memberId, dealt } },
            { transport },
          );
        },
        // Fires on a reconnect too, which is what makes it the resync point.
        onMemberEntered: ({ connectionId }) =>
          reply(connectionId, snapshot(raid), { transport }),
        onGameEnd: ({ context, reason }) =>
          broadcast(
            Object.keys(context.connectedUsers),
            { type: "result", payload: { reason, damage: raid.damage } },
            { transport },
          ),
        // Connections are still open in onGameEnd, so the result gets out
        // before this delay and the drops that follow it.
        endDropDelayMillis: 0,
        logger: nullLogger,
      }),
  });

  await players();
  await actor;

  return { transport, bossHp: raid.bossHp, cleared: isCleared(raid) };
}

export async function main(): Promise<GameOutcome> {
  const outcome = await runGame((line) => {
    console.log(line);
  });
  console.log(
    `\nboss hp ${outcome.bossHp}/12, cleared=${String(outcome.cleared)}, ` +
      `${outcome.transport.frames.length} frames, ` +
      `${outcome.transport.dropped.length} connections dropped`,
  );
  return outcome;
}

if (process.argv[1]?.endsWith("main.ts")) {
  await main();
}
