import type { BoardTopOptions } from "./extended-types.js";
import {
  createPlatformClient,
  type PlatformBoardPeriod,
} from "@yingyeothon/platform-client";
import { kitError, type Runtime } from "./runtime.js";
import type { Board, BoardPage } from "./extended-types.js";
function bucket(v: PlatformBoardPeriod) {
  return { period: v.period, periodKey: v.periodKey, endsAt: v.periodEndsAt };
}
export async function createBoard(
  runtime: Runtime,
  alias: string,
): Promise<Board> {
  const name = runtime.options.config.boards?.[alias];
  const baseUrl = runtime.options.config.state?.url;
  if (
    !name ||
    !baseUrl ||
    !Object.hasOwn(runtime.options.config.boards!, alias)
  )
    throw kitError("board", "not_configured");
  const client = () =>
    createPlatformClient({
      baseUrl,
      token: runtime.identity?.token,
      fetch: runtime.options.fetch,
    }).board(name);
  const info = await runtime.run("board", () => client().info());
  const top = (options: BoardTopOptions) =>
    runtime.run("board", async () => {
      const v = await client().top(options);
      return { ...bucket(v), total: v.total, entries: v.entries };
    });
  return {
    periods: info.periods.map(bucket),
    rule: info.rule,
    order: info.order,
    submit(options) {
      if (info.submit === "server")
        return Promise.reject(kitError("board", "server_only"));
      return runtime.run("board", async () => {
        const generation = runtime.generation;
        const c = client();
        const result = await c.submit(options);
        const scores = [];
        for (const period of result.periods) {
          if (generation !== runtime.generation)
            throw kitError("board", "signed_out");
          const own = await c.me(period.period);
          if (!own) throw kitError("board", "unavailable");
          scores.push({
            period: period.period,
            rank: own.rank,
            score: period.score,
            endsAt: period.periodEndsAt,
          });
        }
        return scores;
      });
    },
    top,
    me(period) {
      return runtime.run("board", async () => {
        const v = await client().me(period);
        return v ? { score: v.score, rank: v.rank, total: v.total } : undefined;
      });
    },
    around({ period, span }) {
      return runtime.run("board", async () => {
        if (!Number.isInteger(span) || span < 0 || span > 49)
          throw new RangeError("board span must be 0–49");
        const generation = runtime.generation;
        const c = client();
        const mine = await c.me(period);
        if (generation !== runtime.generation)
          throw kitError("board", "signed_out");
        if (!mine) {
          const current = info.periods.find((p) => p.period === period);
          if (!current) throw new RangeError("Unknown board period");
          return {
            ...bucket(current),
            entries: [],
            total: 0,
          } satisfies BoardPage;
        }
        const offset = Math.max(0, mine.rank - span - 1);
        return top({ period, offset, limit: span * 2 + 1 });
      });
    },
  };
}
