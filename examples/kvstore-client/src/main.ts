import {
  createKvStoreClient,
  isKvConflict,
  isKvForbidden,
  type KvStoreError,
} from "@yingyeothon/kvstore-client";
import { createFakeKvServer } from "./fake-kv-server.js";

interface Notice {
  title: string;
}

interface Profile {
  name: string;
  volume: number;
}

export interface Report {
  /** Titles from the `announcements` collection, newest key first. */
  announcements: string[];
  /** Nothing a player does can write an announcement. */
  announcementWrite: string;
  /** The profile after save, load, and a second save over the first. */
  profile: Profile | undefined;
  versions: number[];
  /** What a stale `ifMatch` gets: the conflict, with the live version. */
  staleWrite:
    { status: number; currentVersion: number | null | undefined } | "accepted";
  /** Every request, as the fake server saw it. */
  requests: string[];
}

export async function run(): Promise<Report> {
  // In a game these two come from the sign-in flow: the state stack's origin
  // and the channel JWT that the gateway client already holds.
  const baseUrl = "https://doc-dev.yyt.life";
  const token = "a.channel.jwt";

  const server = createFakeKvServer(
    {
      // Set up once in the console: read by every player, written by the team.
      announcements: { readScope: "project", writeScope: "team" },
      // Each player's own records, invisible to the other players.
      profile: { readScope: "user", writeScope: "user" },
    },
    { userId: "0123456789abcdef0123456789abcdef", token },
  );
  server.seed("announcements", "", "2026-09-01-maintenance", {
    title: "Maintenance on Monday",
  });
  server.seed("announcements", "", "2026-09-06-season-2", {
    title: "Season 2 starts",
  });

  const kv = createKvStoreClient({ baseUrl, token, fetch: server.fetch });

  // (1) Announcements: one listing with values, newest first.
  const announcements = kv.collection("announcements");
  const { entries } = await announcements.list<Notice>({
    values: true,
    order: "desc",
  });
  let announcementWrite: Report["announcementWrite"] = "accepted";
  try {
    await announcements.put("2026-09-07-hax", { title: "free gold" });
  } catch (error) {
    announcementWrite = isKvForbidden(error)
      ? "forbidden"
      : (error as Error).message;
  }

  // (2) My record: `mine` is `/kv/profile/u/me/entries`; the server resolves
  // `me` from the JWT, so no user id is ever typed on the client.
  const mine = kv.collection("profile").mine;
  const versions: number[] = [];
  const first = await mine.put("settings", {
    name: "lacti",
    volume: 0.8,
  } satisfies Profile);
  versions.push(first.version!);

  const loaded = await mine.getEntry<Profile>("settings");
  const second = await mine.put(
    "settings",
    { ...loaded!.value, volume: 0.5 },
    { ifMatch: loaded!.version }, // write only over the version we read
  );
  versions.push(second.version!);

  // A write that read version 1 and lands after version 2 exists must lose.
  let staleWrite: Report["staleWrite"] = "accepted";
  try {
    await mine.put("settings", { name: "lacti", volume: 1 }, { ifMatch: 1 });
  } catch (error) {
    if (!isKvConflict(error)) throw error;
    const conflict: KvStoreError = error;
    staleWrite = {
      status: conflict.status,
      currentVersion: conflict.currentVersion,
    };
  }

  const profile = await mine.get<Profile>("settings");

  return {
    announcements: entries.map((entry) => entry.value!.title),
    announcementWrite,
    profile,
    versions,
    staleWrite,
    requests: server.log,
  };
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].split("/").pop()!);

if (isMain) {
  const report = await run();
  const out = (line: string) => process.stdout.write(`${line}\n`);
  out(`announcements:        ${JSON.stringify(report.announcements)}`);
  out(`a player writing one: ${report.announcementWrite}`);
  out(`my profile:           ${JSON.stringify(report.profile)}`);
  out(`versions after saves: ${report.versions.join(" -> ")}`);
  out(`stale ifMatch=1:      ${JSON.stringify(report.staleWrite)}`);
  out("");
  out(
    "requests the client made (the token rode in Authorization, never here):",
  );
  for (const line of report.requests) out(`  ${line}`);
}
