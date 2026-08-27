import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

describe("public API", () => {
  it("exports exactly the documented runtime symbols", () => {
    expect(Object.keys(api).sort()).toEqual([
      "GatewayCloseCode",
      "buildGatewayUrl",
      "classifyClose",
      "createBackoff",
      "createGatewayGameClient",
      "createGatewayLobbyClient",
      "createMapFetcher",
      "createPeerMap",
      "fetchMap",
      "reservedGameFrameTypes",
    ]);
  });

  it("lists every runtime export in the README", () => {
    const readme = readFileSync(
      new URL("../README.md", import.meta.url),
      "utf8",
    );
    for (const name of Object.keys(api)) {
      expect(readme, `README lacks ${name}`).toContain(`\`${name}`);
    }
  });

  it("builds the gateway URL with the query on either side", () => {
    expect(api.buildGatewayUrl("wss://gw", "c")).toBe("wss://gw/?channel=c");
    expect(api.buildGatewayUrl("wss://gw/?a=1", "c", "g")).toBe(
      "wss://gw/?a=1&channel=c&gameId=g",
    );
  });
});
