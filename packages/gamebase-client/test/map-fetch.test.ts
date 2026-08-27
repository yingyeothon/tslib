import { MockAgent, fetch as undiciFetch } from "undici";
import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../src/index.js";
import { createMapFetcher, fetchMap } from "../src/index.js";

function fakeFetch(body: string, status = 200) {
  const calls: string[] = [];
  const fetch: FetchLike = (url) => {
    calls.push(url);
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(body),
    });
  };
  return { fetch, calls };
}

describe("createMapFetcher", () => {
  it("parses JSON and fetches each URL once", async () => {
    const { fetch, calls } = fakeFetch('{"width":4}');
    const fetcher = createMapFetcher({ fetch });
    const [a, b] = await Promise.all([
      fetcher.fetch("https://cdn/map/v1.json"),
      fetcher.fetch("https://cdn/map/v1.json"),
    ]);
    expect(a).toEqual({ width: 4 });
    expect(b).toBe(a);
    expect(calls).toEqual(["https://cdn/map/v1.json"]);
    await fetcher.fetch("https://cdn/map/v2.json");
    expect(calls).toEqual([
      "https://cdn/map/v1.json",
      "https://cdn/map/v2.json",
    ]);
  });

  it("returns a non-JSON body as text", async () => {
    const { fetch } = fakeFetch("<map/>");
    await expect(
      createMapFetcher({ fetch }).fetch("https://cdn/m"),
    ).resolves.toBe("<map/>");
  });

  it("rejects on a non-2xx status and retries on the next call", async () => {
    let status = 500;
    const calls: string[] = [];
    const fetch: FetchLike = (url) => {
      calls.push(url);
      return Promise.resolve({
        ok: status === 200,
        status,
        text: () => Promise.resolve("{}"),
      });
    };
    const fetcher = createMapFetcher({ fetch });
    await expect(fetcher.fetch("https://cdn/m")).rejects.toThrow("status 500");
    status = 200;
    await expect(fetcher.fetch("https://cdn/m")).resolves.toEqual({});
    expect(calls).toHaveLength(2);
  });

  it("sends a plain credential-free GET over a real fetch", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get("https://cdn.example")
      .intercept({ path: "/map/v1.json", method: "GET" })
      .reply(
        200,
        { tiles: [] },
        { headers: { "content-type": "application/json" } },
      );
    const seen = vi.fn();
    const fetch: FetchLike = async (url) => {
      const response = await undiciFetch(url, { dispatcher: agent });
      seen(url);
      return response;
    };
    await expect(
      fetchMap("https://cdn.example/map/v1.json", { fetch }),
    ).resolves.toEqual({
      tiles: [],
    });
    expect(seen).toHaveBeenCalledWith("https://cdn.example/map/v1.json");
    agent.assertNoPendingInterceptors();
    await agent.close();
  });

  it("uses the global fetch when none is injected", async () => {
    const original = globalThis.fetch;
    const { fetch } = fakeFetch("1");
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    try {
      await expect(fetchMap("https://cdn/m")).resolves.toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});
