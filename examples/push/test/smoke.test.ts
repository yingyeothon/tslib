import { expect, it } from "vitest";
import { runExample } from "../src/main.js";
it("runs without Firebase, credentials or deployed services", async () => {
  expect(await runExample()).toMatchObject({
    sent: { sent: 1, noToken: 1, failed: 0 },
    created: true,
    replayed: true,
    broadcast: "broadcast",
  });
});
