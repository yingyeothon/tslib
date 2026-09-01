import {
  createInMemoryLock,
  createInMemoryQueue,
  eventLoop,
  type UserMessage,
} from "@yingyeothon/actor-system";
import { createRedisQueue } from "@yingyeothon/actor-system-redis";
import type { GatewayCommand } from "@yingyeothon/lambda-gamebase";
import { nullLogger } from "@yingyeothon/logger";
import { createRedisConnection } from "@yingyeothon/naive-redis";
import { buildUserMessage, queueKeyFor } from "./envelope.js";
import {
  applyGatewayCommand,
  parseGatewayCommand,
  type GatewayFanOut,
} from "./gateway.js";

const gameId = "bridge-1";
const queueKeyPrefix = "game:dev:demo:queue:";
const channelPrefix = "game:out:dev:demo:";

interface Move {
  type: "move";
  connectionId: string;
  x: number;
}

export interface ContractReport {
  /** The exact Redis key the gateway must RPUSH into. */
  queueKey: string;
  /** What the actor saw for a correctly wrapped push. */
  wrapped: (Move | undefined)[];
  /** What it saw for a bare payload — the silent failure. */
  bare: (Move | undefined)[];
  /** What a gateway ends up delivering for both send shapes. */
  fanOut: GatewayFanOut;
}

/**
 * Drains a queue exactly as the actor loop does and reports the `item` of each
 * message — which is `undefined` when the push was not an envelope.
 */
async function drain(
  queue: ReturnType<typeof createInMemoryQueue>,
): Promise<(Move | undefined)[]> {
  const seen: (Move | undefined)[] = [];
  await eventLoop<Move>({
    id: gameId,
    queue,
    lock: createInMemoryLock(),
    logger: nullLogger,
    loop: async (poll) => {
      for (const item of await poll()) seen.push(item);
    },
  });
  return seen;
}

export async function runContract(): Promise<ContractReport> {
  // 1. The envelope. Both pushes look fine to Redis; only one is readable.
  const good = createInMemoryQueue();
  await good.push(
    gameId,
    buildUserMessage<Move>({
      type: "move",
      connectionId: "c1",
      x: 3,
    }),
  );

  const bad = createInMemoryQueue();
  // A bare payload, which is what a gateway writes when it reads the game's
  // message table and not this contract.
  await bad.push(gameId, {
    type: "move",
    connectionId: "c1",
    x: 3,
  } as unknown as UserMessage<Move>);

  const wrapped = await drain(good);
  const bare = await drain(bad);

  // 2. Both outbound shapes, as the actor publishes them.
  const fanOut: GatewayFanOut = { delivered: [], closed: [] };
  const published: GatewayCommand[] = [
    { op: "send", connectionId: "c1", message: { type: "stage" } },
    { op: "send", connectionIds: ["c1", "c2"], message: { type: "tick" } },
    { op: "drop", connectionId: "c2" },
  ];
  for (const command of published) {
    const parsed = parseGatewayCommand(JSON.stringify(command));
    if (parsed) applyGatewayCommand(parsed, fanOut);
  }

  return {
    queueKey: queueKeyFor(queueKeyPrefix, gameId),
    wrapped,
    bare,
    fanOut,
  };
}

/**
 * The same push against a real Redis, so the key and the TTL are observable.
 * Opt-in, and namespaced: a plain `REDIS_HOST` is already exported to a real
 * store in the environments this repository is developed in.
 */
export async function runAgainstRedis(host: string): Promise<number> {
  const connection = createRedisConnection({
    host,
    port: Number(process.env["YYT_EXAMPLE_REDIS_PORT"] ?? 6379),
  });
  try {
    const queue = createRedisQueue({
      connection,
      keyPrefix: queueKeyPrefix,
      // Required, and re-applied on every push: the actor only drains, so a
      // queue abandoned by a dead actor must expire on the producer's terms.
      ttlSeconds: 60,
    });
    // `push` resolves the list depth, which is how a gateway notices for free
    // that nobody is consuming.
    const depth = await queue.push(
      gameId,
      buildUserMessage<Move>({
        type: "move",
        connectionId: "c1",
        x: 3,
      }),
    );
    await queue.flush(gameId);
    return depth;
  } finally {
    connection.socket.disconnect();
  }
}

export async function main(): Promise<void> {
  const report = await runContract();
  console.log(`queue key the actor drains: ${report.queueKey}`);
  // Printed with String(), not JSON.stringify: an `undefined` inside an array
  // serialises as `null`, which would hide the very thing this demonstrates.
  const show = (items: (Move | undefined)[]) =>
    `[${items.map((item) => (item === undefined ? "undefined" : JSON.stringify(item))).join(", ")}]`;
  console.log(`  a UserMessage envelope -> ${show(report.wrapped)}`);
  console.log(`  a bare payload         -> ${show(report.bare)}`);
  console.log("    ^ one undefined, no error: the game simply never sees it");
  console.log("outbound, both send shapes:");
  for (const frame of report.fanOut.delivered) {
    console.log(
      `  -> ${frame.connectionIds.join(",")}  ${JSON.stringify(frame.message)}`,
    );
  }
  console.log(`  closed: ${report.fanOut.closed.join(",")}`);

  const host = process.env["YYT_EXAMPLE_REDIS_HOST"];
  if (host !== undefined) {
    const depth = await runAgainstRedis(host);
    console.log(`against redis: RPUSH answered depth ${depth}`);
  }
}

if (process.argv[1]?.endsWith("main.ts")) {
  await main();
}
