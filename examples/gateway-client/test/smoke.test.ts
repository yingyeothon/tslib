import { GatewayCloseCode } from "@yingyeothon/gamebase-client";
import { describe, expect, it } from "vitest";
import { runDungeon, runLobby } from "../src/main.js";

describe("gateway-client example", () => {
  it("carries the token in the subprotocol and never in the URL", async () => {
    const report = await runLobby();

    expect(report.requestedUrl).toBe("wss://gw.yyt.life/?channel=lobby_demo");
    expect(report.requestedUrl).not.toContain("a.channel.jwt");
    expect(report.protocols).toEqual(["bearer", "a.channel.jwt"]);
  });

  it("resolves connect() on hello, then tracks peers", async () => {
    const report = await runLobby();

    expect(report.helloZone).toBe("town");
    // The snapshot placed u2 at x=1 and the pos frame moved it to x=4. A
    // dropped frame would leave it at 1, which is what a missing `zone` did.
    expect(report.peers).toEqual([{ userId: "u2", x: 4, y: 1 }]);
  });

  it.each([
    [1000, "finished"],
    [GatewayCloseCode.aborted, "aborted"],
  ])(
    "tells a finished run from an aborted one (close %i)",
    async (code, expected) => {
      const ending = await runDungeon(code);
      expect(ending.disposition).toBe(expected);
      expect(ending.event).toBe(expected);
    },
  );
});
