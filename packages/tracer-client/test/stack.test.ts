import { describe, expect, it } from "vitest";
import { createTracerClient } from "../src/index.js";
import { createFakeFetch, fixtureDsn } from "./support.js";

async function exceptionOf(error: unknown) {
  const fake = createFakeFetch();
  const c = createTracerClient({
    dsn: fixtureDsn,
    fetch: fake.fetch,
    corsSafe: false,
    compress: false,
  });
  await c.report("r", { error });
  await c.flush();
  return (
    fake.sent[0]!.envelope.items[0]!.json["exception"] as {
      values: Record<string, unknown>[];
    }
  ).values[0]!;
}

function withStack(stack: string): Error {
  const e = new TypeError("boom");
  e.stack = stack;
  return e;
}

describe("stack frames", () => {
  it("parses a V8 stack, oldest first", async () => {
    const ex = await exceptionOf(
      withStack(
        [
          "TypeError: boom",
          "    at Game.tick (file:///srv/app/src/game.js:10:5)",
          "    at async Promise.all (index 0)",
          "    at new Loop (/srv/app/node_modules/engine/loop.js:3:1)",
          "    at node:internal/timers:581:17",
          "    at /srv/app/dist/main.js:1:2",
        ].join("\n"),
      ),
    );
    expect(ex["type"]).toBe("TypeError");
    expect(ex["value"]).toBe("boom");
    const frames = (ex["stacktrace"] as { frames: Record<string, unknown>[] })
      .frames;
    expect(
      frames.map((f) => [
        f["filename"],
        f["function"],
        f["lineno"],
        f["in_app"],
      ]),
    ).toEqual([
      ["srv/app/dist/main.js", "?", 1, true],
      ["node:internal/timers", "?", 581, false],
      ["node_modules/engine/loop.js", "new Loop", 3, false],
      ["srv/app/src/game.js", "Game.tick", 10, true],
    ]);
  });

  it("parses a Firefox/Safari stack", async () => {
    const ex = await exceptionOf(
      withStack(
        [
          "move@https://game.example/assets/a.js?v=2:4:9",
          "@https://game.example/assets/b.js:1:1",
          "inline@https://game.example/:17:5",
          "[native code]",
        ].join("\n"),
      ),
    );
    const frames = (ex["stacktrace"] as { frames: Record<string, unknown>[] })
      .frames;
    expect(
      frames.map((f) => [f["filename"], f["function"], f["colno"]]),
    ).toEqual([
      ["https://game.example/", "inline", 5],
      ["assets/b.js", "?", 1],
      ["assets/a.js", "move", 9],
    ]);
  });

  it("keeps the innermost 200 frames", async () => {
    const lines = ["Error: deep"];
    for (let i = 0; i < 250; i++)
      lines.push(`    at f${i} (/a/s.js:${i + 1}:1)`);
    const ex = await exceptionOf(withStack(lines.join("\n")));
    const frames = (ex["stacktrace"] as { frames: Record<string, unknown>[] })
      .frames;
    expect(frames).toHaveLength(200);
    expect(frames[199]!["function"]).toBe("f0");
  });

  it("omits the stacktrace for an unknown format", async () => {
    const ex = await exceptionOf(withStack("nothing to see"));
    expect(ex["stacktrace"]).toBeUndefined();
  });

  it("reads a real Error", async () => {
    const ex = await exceptionOf(new RangeError("real"));
    expect(ex["type"]).toBe("RangeError");
    const frames = (ex["stacktrace"] as { frames: Record<string, unknown>[] })
      .frames;
    expect(frames.length).toBeGreaterThan(0);
    expect(String(frames.at(-1)!["filename"])).toContain("stack.test.ts");
  });
});
