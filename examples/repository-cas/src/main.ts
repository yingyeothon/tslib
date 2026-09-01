import { createRedisConnection } from "@yingyeothon/naive-redis";
import {
  createInMemoryRepository,
  createMapDocument,
} from "@yingyeothon/repository";
import { createRedisRepository } from "@yingyeothon/repository-redis";
import { stallFirstWrite, type CasStore } from "./stall.js";

/**
 * Every write here carries a TTL. `@yingyeothon/repository-redis` refuses a
 * TTL-less write outright, and on the shared Redis a key that never expires
 * evicts someone else's first — so the document helpers take it too.
 */
const expiresInMillis = 60_000;

export interface RaceResult {
  /** The document after both writers finished. */
  scores: Record<string, number>;
  /** One write each, so a correct run lands on 2. */
  version: number;
  /** True when the losing writer's conditional write was actually refused. */
  loserWasRefused: boolean;
}

/**
 * Two writers edit one document from the same starting revision. The one that
 * commits second finds its revision stale, re-reads, and re-applies — so both
 * names survive. Without the conditional write the second writer would send a
 * whole document built from what it read, and the first writer's name would
 * simply be gone.
 */
export async function runRace(store: CasStore): Promise<RaceResult> {
  const key = `example:scores:${Date.now()}`;
  const stalled = stallFirstWrite(store);
  const scores = createMapDocument<number>({
    repository: stalled.repository,
    key,
    expiresInMillis,
    // The default is 3. A retry re-reads; it never resends what it had.
    maxRetries: 3,
  });

  // Reads the empty document, then blocks inside its conditional write.
  const alice = scores.insertOrUpdate("alice", 1);
  await stalled.firstWriteReached;

  // Reads the same empty document and commits first, unblocked.
  await scores.insertOrUpdate("bob", 2);

  // Alice's write now carries a revision the store has moved past.
  stalled.release();
  await alice;

  const document = await scores.read();

  // The same refusal, without the document helper doing it for you. Read a
  // revision, let something else write, and the token no longer matches: the
  // conditional write resolves `false` and stores nothing. That `false` is the
  // whole mechanism — the helper above simply re-reads and retries on it.
  const stale = await store.getRevision<unknown>(key);
  await store.setWithExpire(key, document, expiresInMillis);
  const loserWasRefused = !(await store.compareAndSet(
    key,
    stale?.token,
    { version: 99, content: { mallory: 99 } },
    { expiresInMillis },
  ));

  await store.delete(key);

  return {
    scores: document.content,
    version: document.version,
    loserWasRefused,
  };
}

/**
 * In-memory by default. `YYT_EXAMPLE_REDIS_HOST` points the identical script at
 * a Redis you started yourself — deliberately not `REDIS_HOST`, which is
 * already set to a real store in the environments this repository is developed
 * in, and an example must never reach for one by accident.
 */
export function openStore(): { store: CasStore; close: () => void } {
  const host = process.env["YYT_EXAMPLE_REDIS_HOST"];
  if (host === undefined) {
    return { store: createInMemoryRepository(), close: () => undefined };
  }
  const connection = createRedisConnection({
    host,
    port: Number(process.env["YYT_EXAMPLE_REDIS_PORT"] ?? 6379),
  });
  return {
    store: createRedisRepository({ redisConnection: connection }),
    close: () => connection.socket.disconnect(),
  };
}

export async function main(): Promise<RaceResult> {
  const { store, close } = openStore();
  try {
    const result = await runRace(store);
    console.log(
      `backend: ${process.env["YYT_EXAMPLE_REDIS_HOST"] === undefined ? "in-memory" : "redis"}`,
    );
    console.log(`scores:  ${JSON.stringify(result.scores)}`);
    console.log(`version: ${result.version} (one write each)`);
    console.log(
      `the stale write was refused: ${String(result.loserWasRefused)}`,
    );
    return result;
  } finally {
    close();
  }
}

// `tsx src/main.ts` runs it; the smoke test imports `runRace` instead.
if (process.argv[1]?.endsWith("main.ts")) {
  await main();
}
