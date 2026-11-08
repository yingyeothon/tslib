import { combine, createFilteredLogger } from "@yingyeothon/logger";
import { describe, expect, it } from "vitest";
import { createTracerClient, createTracerLogWriter } from "../src/index.js";
import { createFakeFetch, fixtureDsn } from "./support.js";

function setup() {
  const fake = createFakeFetch();
  const client = createTracerClient({
    dsn: fixtureDsn,
    fetch: fake.fetch,
    corsSafe: false,
    compress: false,
  });
  return { fake, client };
}

describe("createTracerLogWriter", () => {
  it("forwards the logger call style as log lines and breadcrumbs", async () => {
    const { fake, client } = setup();
    const logger = createFilteredLogger({
      severity: "info",
      writer: combine(createTracerLogWriter(client)),
    });
    logger.debug("filtered out");
    logger.info("actor started", { actorId: "a1", n: 2 });
    logger.warn("slow", 42);
    logger.error(new TypeError("bad"), { at: "x" });
    await client.report("r");
    await client.flush();
    const [event, logs] = fake.sent[0]!.envelope.items;
    const entries = logs!.json["items"] as Record<string, unknown>[];
    expect(entries.map((e) => [e["level"], e["body"]])).toEqual([
      ["info", "actor started"],
      ["warn", "slow"],
      ["error", "TypeError: bad"],
    ]);
    expect(entries[0]!["attributes"]).toMatchObject({
      actorId: { value: "a1", type: "string" },
      n: { value: 2, type: "integer" },
    });
    expect(entries[1]!["attributes"]).toMatchObject({
      arg1: { value: 42, type: "integer" },
    });
    expect(entries[2]!["attributes"]).toMatchObject({
      "error.type": { value: "TypeError", type: "string" },
      "error.message": { value: "bad", type: "string" },
      at: { value: "x", type: "string" },
    });
    const crumbs = (
      event!.json["breadcrumbs"] as { values: Record<string, unknown>[] }
    ).values;
    expect(
      crumbs.map((b) => [b["category"], b["level"], b["message"]]),
    ).toEqual([
      ["log", "info", "actor started"],
      ["log", "warning", "slow"],
      ["log", "error", "TypeError: bad"],
    ]);
  });

  it("skips breadcrumbs when asked, and does nothing for an off client", async () => {
    const { fake, client } = setup();
    const writer = createTracerLogWriter(client, { breadcrumbs: false });
    writer.debug("d");
    await client.report("r");
    await client.flush();
    expect(
      (fake.sent[0]!.envelope.items[0]!.json["breadcrumbs"] as { values: [] })
        .values,
    ).toEqual([]);
    const off = createTracerLogWriter(createTracerClient({ dsn: "" }));
    expect(() => off.info("x")).not.toThrow();
  });

  it("never throws into the caller", () => {
    const writer = createTracerLogWriter({
      enabled: true,
      breadcrumb: () => {
        throw new Error("boom");
      },
    } as never);
    expect(() => writer.info("x")).not.toThrow();
  });
});
