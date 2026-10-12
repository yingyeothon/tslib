import { describe, expect, it, vi } from "vitest";
import { createPlatformClient, isPlatformClientError } from "../src/index.js";
import { fakeResponse } from "../../../test-support/game-kit-fakes.js";
describe("platform clock", () => {
  it("calls time without credentials and exposes milliseconds", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        fakeResponse(200, {
          now: "2026-01-01T00:00:00Z",
          epochMs: 1767225600000,
        }),
      ),
    );
    expect(
      await createPlatformClient({
        baseUrl: "https://fake.invalid/",
        fetch,
      }).time(),
    ).toEqual({ now: "2026-01-01T00:00:00Z", epochMs: 1767225600000 });
    expect(fetch).toHaveBeenCalledWith("https://fake.invalid/time", {
      method: "GET",
      headers: {},
    });
  });
  it.each([
    null,
    {},
    [],
    { now: 3, epochMs: 1 },
    { now: "time", epochMs: 0.5 },
    "secret",
  ])("rejects malformed response %j safely", async (body) => {
    await expect(
      createPlatformClient({
        baseUrl: "https://fake.invalid",
        fetch: () => Promise.resolve(fakeResponse(200, body)),
      }).time(),
    ).rejects.toMatchObject({ code: "malformed_response" });
  });
  it("handles HTTP and network failures without retaining secrets", async () => {
    const http = createPlatformClient({
      baseUrl: "https://fake.invalid",
      fetch: () => Promise.resolve(fakeResponse(429, "SECRET")),
    });
    const error: unknown = await http.time().catch((e) => e as unknown);
    expect(isPlatformClientError(error)).toBe(true);
    expect(error).toMatchObject({ status: 429 });
    expect(isPlatformClientError(null)).toBe(false);
    await expect(
      createPlatformClient({
        baseUrl: "https://fake.invalid",
        fetch: () => Promise.reject(new Error("SECRET")),
      }).time(),
    ).rejects.toMatchObject({ code: "network" });
    for (const url of [
      "bad",
      "ftp://a",
      "https://u:p@a",
      "https://a?q=x",
      "https://a#x",
    ])
      expect(() => createPlatformClient({ baseUrl: url })).toThrow(RangeError);
  });
  it("uses the global fetch default and refuses when it is unavailable", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(fakeResponse(200, { now: "time", epochMs: 1 })),
    );
    try {
      expect(
        (await createPlatformClient({ baseUrl: "https://fake.invalid" }).time())
          .epochMs,
      ).toBe(1);
      vi.stubGlobal("fetch", undefined);
      expect(() =>
        createPlatformClient({ baseUrl: "https://fake.invalid" }),
      ).toThrow("No fetch");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
