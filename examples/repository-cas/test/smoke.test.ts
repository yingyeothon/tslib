import { createInMemoryRepository } from "@yingyeothon/repository";
import { describe, expect, it } from "vitest";
import { runRace } from "../src/main.js";

describe("repository-cas example", () => {
  it("keeps both writers' changes when they race on one document", async () => {
    const result = await runRace(createInMemoryRepository());

    // The point of the example: neither writer clobbered the other.
    expect(result.scores).toEqual({ alice: 1, bob: 2 });
    // One write each. A last-writer-wins store would land on 1.
    expect(result.version).toBe(2);
    // And the conditional write really did refuse the stale revision, rather
    // than the document merely happening to look right.
    expect(result.loserWasRefused).toBe(true);
  });
});
