import { describe, expect, it } from "vitest";
import { run } from "../src/main.js";

describe("kvstore-client example", () => {
  it("reads announcements newest first and cannot write them", async () => {
    const report = await run();
    expect(report.announcements).toEqual([
      "Season 2 starts",
      "Maintenance on Monday",
    ]);
    expect(report.announcementWrite).toBe("forbidden");
  });

  it("saves and loads the player's own record under /u/me", async () => {
    const report = await run();
    expect(report.profile).toEqual({ name: "lacti", volume: 0.5 });
    expect(report.versions).toEqual([1, 2]);
    expect(report.requests).toContain("PUT /kv/profile/u/me/entries/settings");
    expect(report.requests).toContain(
      'PUT /kv/profile/u/me/entries/settings ("1")',
    );
    // The token never appears in a path.
    expect(report.requests.join("\n")).not.toContain("a.channel.jwt");
  });

  it("loses a write made over a version that is no longer current", async () => {
    const report = await run();
    expect(report.staleWrite).toEqual({ status: 409, currentVersion: 2 });
  });
});
