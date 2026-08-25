import type { RedisConnection } from "./connection.js";
import { serializeCommand } from "./exchange/serialize.js";
import { singleInteger } from "./exchange/singleInteger.js";

export interface RedisEvalOptions {
  /** Keys the script touches; becomes `KEYS[1..n]` and `NUMKEYS`. */
  keys?: string[];
  /** Everything else the script needs; becomes `ARGV[1..n]`. */
  args?: string[];
  /**
   * Jump the connection's request queue. A lock heartbeat has to reach
   * Redis before the lease expires, and the queue ahead of it belongs to
   * the work the lease is protecting.
   */
  urgent?: boolean;
}

/**
 * Runs a Lua script and reads an **integer** reply.
 *
 * Integer is the only shape this resolves, because it is the shape the
 * compare-and-delete lock needs. Other shapes are still framed off the
 * connection before rejecting, so a script that returns a string or a flat
 * table fails loudly instead of leaving its tail in the receive buffer for
 * the next command to resolve with. A **nested** table cannot be framed —
 * do not return one. Add a sibling helper rather than widening this.
 */
export function redisEval(
  connection: RedisConnection,
  script: string,
  { keys = [], args = [], urgent }: RedisEvalOptions = {},
): Promise<number> {
  return singleInteger(
    connection,
    [
      serializeCommand([
        "EVAL",
        script,
        keys.length.toString(),
        ...keys,
        ...args,
      ]),
    ],
    urgent,
  );
}
