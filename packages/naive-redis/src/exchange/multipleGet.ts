import type { RedisConnection } from "../connection.js";
import { redisSend } from "../send.js";
import { ensureValue } from "./ensureValue.js";

export function multipleGet(
  connection: RedisConnection,
  commands: string[],
): Promise<string[]> {
  return redisSend({
    connection,
    commands,
    match: (m) => {
      m.capture("\r\n");
      const first = m.values()[0];
      if (!first || first === "*0" || first.startsWith("-")) {
        return m;
      }
      const count = +first.slice(1);
      for (let index = 0; index < count; ++index) {
        m.capture("\r\n").capture("\r\n");
      }
      return m;
    },
    transform: (result) => {
      const length = +ensureValue(result, 0, /\*([0-9]+)/);
      const values = result.filter(
        (_, index) => index !== 0 && index % 2 === 0,
      );
      if (length !== values.length) {
        throw new Error("Error: mismatch length");
      }
      return values;
    },
  });
}
