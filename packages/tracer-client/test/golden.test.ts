// The golden envelope of this library. Its bytes are also committed to the
// service repository as tracer/testdata/envelopes/yyt-ts/report.envelope,
// where tracer's Go tests ingest it (the wire contract: "each library's tests
// decode their own output against the same expectations"). Regenerate with
// `UPDATE_GOLDEN=1 pnpm vitest run packages/tracer-client/test/golden.test.ts`
// and copy the file there unchanged.
//
// The envelope carries the package version (`sdk.version`, the
// `sentry.sdk.version` attribute), which the Release workflow stamps before
// it runs the tests, so the comparison is byte-for-byte only while the
// version equals the golden's and structural (version normalised) otherwise.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTracerClient, tracerSdkVersion } from "../src/index.js";
import {
  createFakeFetch,
  fixtureDsn,
  parseEnvelope,
  sequenceRandom,
  settle,
  steppingClock,
} from "./support.js";
import type { ParsedEnvelope } from "./support.js";

const goldenPath = fileURLToPath(
  new URL("./golden/report.envelope", import.meta.url),
);

/** A 1×1 transparent PNG. */
const onePixelPng = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/** What a web game's "report this" sends, with a fixed clock and fixed ids. */
async function goldenReport(
  dsn = fixtureDsn,
  fetch = createFakeFetch().fetch,
  allowHttpLoopback = false,
) {
  const client = createTracerClient({
    dsn,
    release: "web-game@0.1.0+1",
    dist: "abc1234",
    environment: "debug",
    tags: { git_sha: "abc1234", runtime: "browser" },
    userId: "00000000000000000000000000000000",
    contexts: {
      os: { name: "Linux" },
      browser: { name: "Chrome", version: "153" },
      device: { model: "fixture-device" },
    },
    fetch,
    now: steppingClock(),
    // Not 0: the yyt-dart golden starts there, and the Go tests ingest both
    // fixtures into one resource, where equal event ids deduplicate.
    randomBytes: sequenceRandom(0x40),
    corsSafe: false,
    compress: true,
    allowHttpLoopback,
  });
  client.setTag("feature", "board");
  client.trace("navigation", "open /board", {
    data: { from: "/", to: "/board" },
  });
  client.trace("ui", "tap square", {
    data: { square: "e2", piece: 1, legal: false },
  });
  client.log("warning", "move rejected", {
    square: "e2",
    ms: 12.5,
    attempt: 2,
    legal: false,
  });
  const error = new Error("rejected move e2");
  error.name = "MoveError";
  error.stack = [
    "MoveError: rejected move e2",
    "    at Board.move (https://game.example/assets/board-3f2a.js:42:7)",
    "    at HTMLCanvasElement.onTap (https://game.example/assets/main-9c1d.js:88:5)",
    "    at https://game.example/node_modules/.vite/deps/pixi.js?v=1a2b:345:24",
  ].join("\n");
  const eventId = await client.report("capture report: rejected move", {
    data: { board: "8/8/8/8/8/8/4P3/8" },
    screenshot: onePixelPng,
    attachments: [
      {
        filename: "scene.json",
        data: new TextEncoder().encode(
          '{"scene":"board","objects":[{"type":"Piece","square":"e2"}]}',
        ),
        contentType: "application/json",
      },
    ],
    error,
  });
  await client.flush();
  return { client, eventId };
}

/** The envelope with the SDK version replaced, for a structural comparison. */
function normalised(envelope: ParsedEnvelope, version: string) {
  const swap = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value).split(`"${version}"`).join('"<v>"'));
  return {
    header: swap(envelope.header),
    items: envelope.items.map((item) => {
      const header = { ...item.header };
      delete header["length"];
      return item.header["type"] === "attachment"
        ? { header, payload: Buffer.from(item.payload).toString("hex") }
        : { header: swap(header), payload: swap(item.json) };
    }),
  };
}

describe("golden report envelope", () => {
  it("matches the golden file", async () => {
    const fake = createFakeFetch();
    await goldenReport(fixtureDsn, fake.fetch);
    await settle();
    expect(fake.sent).toHaveLength(1);
    const body = fake.sent[0]!.body;
    if (process.env["UPDATE_GOLDEN"] === "1") writeFileSync(goldenPath, body);
    const golden = new Uint8Array(readFileSync(goldenPath));
    const goldenVersion = (
      parseEnvelope(golden).header["sdk"] as { version: string }
    ).version;
    if (goldenVersion === tracerSdkVersion) {
      expect(Buffer.from(body).equals(Buffer.from(golden))).toBe(true);
    }
    expect(normalised(parseEnvelope(body), tracerSdkVersion)).toEqual(
      normalised(parseEnvelope(golden), goldenVersion),
    );
  });

  // The facts tracer stores of it (normalize.Event/Logs, ingest's attachment
  // linkage); the Go side counts its rows.
  it("decodes to what tracer stores", () => {
    const env = parseEnvelope(new Uint8Array(readFileSync(goldenPath)));
    expect(Object.keys(env.header)).toEqual(["event_id", "sent_at", "sdk"]);
    expect((env.header["sdk"] as { name: string }).name).toBe("yyt.ts");
    expect(
      env.items.map(
        (i) =>
          `${String(i.header["type"])}:${typeof i.header["filename"] === "string" ? i.header["filename"] : ""}`,
      ),
    ).toEqual([
      "event:",
      "log:",
      "attachment:screenshot.png",
      "attachment:scene.json",
    ]);
    for (const item of env.items) {
      expect(item.header["length"]).toBe(item.payload.length);
    }
    const event = env.items[0]!.json;
    expect(event["event_id"]).toBe(env.header["event_id"]);
    expect(event["platform"]).toBe("javascript");
    expect(event["level"]).toBe("warning");
    expect(event["release"]).toBe("web-game@0.1.0+1");
    expect(event["dist"]).toBe("abc1234");
    expect(event["environment"]).toBe("debug");
    expect(event["user"]).toEqual({ id: "00000000000000000000000000000000" });
    expect(event["tags"]).toEqual({
      git_sha: "abc1234",
      runtime: "browser",
      feature: "board",
    });
    const contexts = event["contexts"] as Record<string, unknown>;
    expect(contexts["browser"]).toEqual({ name: "Chrome", version: "153" });
    expect(contexts["device"]).toEqual({ model: "fixture-device" });
    expect(Object.keys(contexts["trace"] as object)).toEqual([
      "trace_id",
      "span_id",
    ]);
    const exception = (
      event["exception"] as { values: Record<string, unknown>[] }
    ).values[0]!;
    expect(exception["type"]).toBe("MoveError");
    const frames = (
      exception["stacktrace"] as { frames: Record<string, unknown>[] }
    ).frames;
    expect(frames.map((f) => f["in_app"])).toEqual([false, true, true]);
    expect(frames.map((f) => f["filename"])).toEqual([
      "node_modules/.vite/deps/pixi.js",
      "assets/main-9c1d.js",
      "assets/board-3f2a.js",
    ]);
    expect((event["breadcrumbs"] as { values: unknown[] }).values).toHaveLength(
      2,
    );
    const logs = env.items[1]!;
    expect(logs.header["item_count"]).toBe(3);
    expect(logs.header["content_type"]).toBe(
      "application/vnd.sentry.items.log+json",
    );
    const entries = logs.json["items"] as Record<string, unknown>[];
    expect(entries.map((e) => e["body"])).toEqual([
      "open /board",
      "tap square",
      "move rejected",
    ]);
    expect(typeof entries[0]!["timestamp"]).toBe("number");
    const attrs = entries[2]!["attributes"] as Record<string, unknown>;
    expect(attrs["square"]).toEqual({ value: "e2", type: "string" });
    expect(attrs["ms"]).toEqual({ value: 12.5, type: "double" });
    expect(attrs["attempt"]).toEqual({ value: 2, type: "integer" });
    expect(attrs["legal"]).toEqual({ value: false, type: "boolean" });
    expect(attrs["sentry.release"]).toEqual({
      value: "web-game@0.1.0+1",
      type: "string",
    });
    expect(attrs["device.model"]).toEqual({
      value: "fixture-device",
      type: "string",
    });
    expect(entries[2]!["level"]).toBe("warn");
    expect(entries[2]!["severity_number"]).toBe(13);
    expect(
      Buffer.from(env.items[2]!.payload).equals(Buffer.from(onePixelPng)),
    ).toBe(true);
    expect(env.items[2]!.header["content_type"]).toBe("image/png");
    expect(env.items[3]!.header["attachment_type"]).toBe("event.attachment");
  });
});
