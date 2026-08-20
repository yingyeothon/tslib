import { afterEach, describe, expect, it, vi } from "vitest";
import { readyCall } from "../src/actor/lobby/readyCall.js";

function stubFetch(response: {
  status: number;
  statusText: string;
  body: { cancel: () => Promise<void> } | null;
}): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readyCall", () => {
  it("cancels the response body after a successful call", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    stubFetch({ status: 200, statusText: "OK", body: { cancel } });

    await readyCall("https://lobby.yyt.life/ready");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("resolves a successful call without a response body", async () => {
    stubFetch({ status: 200, statusText: "OK", body: null });
    await expect(readyCall("https://lobby.yyt.life/ready")).resolves.toBe(
      undefined,
    );
  });

  it("cancels the response body and rejects on a non-200 status", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    stubFetch({
      status: 503,
      statusText: "Service Unavailable",
      body: { cancel },
    });

    await expect(readyCall("https://lobby.yyt.life/ready")).rejects.toThrow(
      "503 Service Unavailable",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects on a non-200 status without a response body", async () => {
    stubFetch({ status: 404, statusText: "Not Found", body: null });
    await expect(readyCall("https://lobby.yyt.life/ready")).rejects.toThrow(
      "404 Not Found",
    );
  });
});
