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
