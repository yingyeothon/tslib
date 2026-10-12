import { expect, it } from "vitest";
import { runGameKitDemo } from "../src/main.js";
it("runs the Wave A zero-infrastructure walkthrough", async () => {
  expect(await runGameKitDemo()).toMatchObject({
    warnings: 1,
    tuning: { speed: 2 },
    settings: { volume: 1, speed: 2 },
    claim: [true, false],
    wallet: 3,
    members: 2,
    finalState: [3, 3],
    inherited: { hp: 10 },
  });
});

import { runExtendedGameKitDemo } from "../src/extended.js";
it("runs scenarios 5–10 through the built kit", async () => {
  expect(await runExtendedGameKitDemo()).toEqual({
    periods: 3,
    mailClaims: 1,
    friendOnline: true,
    matchedMembers: 4,
    deferredState: "confirmed",
    subscribed: "configured.topic",
    tokensAfterSignOut: 0,
  });
});
