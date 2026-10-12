import type { PlatformPresence } from "./types.js";
import {
  array,
  bool,
  createHttp,
  int,
  invalid,
  isPlatformClientError,
  nullable,
  num,
  protect,
  segment,
  shape,
  str,
  type Check,
} from "./http.js";
import type {
  BoardPeriod,
  PlatformBoard,
  PlatformBoardInfo,
  PlatformBoardPage,
  PlatformBoardOwnScore,
  PlatformClient,
  PlatformClientOptions,
  PlatformPresenceClient,
  PlatformPresenceClientOptions,
  PlatformProfile,
  PlatformRelation,
  PlatformRequests,
  PlatformSocial,
  PlatformTime,
} from "./types.js";
const period: Check = (v) =>
  ["alltime", "daily", "weekly"].includes(v as string);
const bucket = { period, periodKey: str, periodEndsAt: nullable(int) };
const score = { score: num, meta: nullable(str), rank: int, updatedAt: int };
const profile = shape({
  owner: str,
  displayName: str,
  avatar: nullable(str),
  updatedAt: int,
});
const relation = shape({
  owner: str,
  displayName: nullable(str),
  avatar: nullable(str),
  since: int,
});
function player(id: string): string {
  if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id))
    throw invalid("Invalid player id");
  return id;
}
function batch(ids: string[]): string {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50)
    throw invalid("Expected 1–50 player ids");
  return [...new Set(ids.map(player))].join(",");
}
function periodOf(value: BoardPeriod): void {
  if (!period(value)) throw invalid("Invalid board period");
}
export function createPlatformClient(
  options: PlatformClientOptions,
): PlatformClient {
  const http = createHttp(options);
  const social = protect<PlatformSocial>({
    async profile() {
      try {
        return await http<PlatformProfile>(
          "/social/me/profile",
          "GET",
          [200],
          profile,
        );
      } catch (e) {
        if (isPlatformClientError(e) && e.status === 404) return undefined;
        throw e;
      }
    },
    async setProfile({ displayName, avatar }) {
      if (
        typeof displayName !== "string" ||
        !displayName ||
        (avatar !== undefined && avatar !== null && typeof avatar !== "string")
      )
        throw invalid("Invalid profile");
      return http("/social/me/profile", "PUT", [200, 201], profile, {
        displayName,
        ...(avatar === undefined ? {} : { avatar }),
      });
    },
    async profiles(ids) {
      const data = await http<{ profiles: PlatformProfile[] }>(
        `/social/profiles?${new URLSearchParams({ ids: batch(ids) }).toString()}`,
        "GET",
        [200],
        shape({ profiles: array(profile) }),
      );
      return data.profiles;
    },
    async friends() {
      return (
        await http<{ friends: PlatformRelation[] }>(
          "/social/friends",
          "GET",
          [200],
          shape({ friends: array(relation) }),
        )
      ).friends;
    },
    async requests() {
      return http<PlatformRequests>(
        "/social/requests",
        "GET",
        [200],
        shape({ incoming: array(relation), outgoing: array(relation) }),
      );
    },
    async request(userId) {
      return http(
        "/social/requests",
        "POST",
        [200, 201],
        shape({ state: str }),
        { to: player(userId) },
      );
    },
    async accept(userId) {
      await http(
        `/social/requests/${player(userId)}/accept`,
        "POST",
        [204],
        (v) => v === undefined,
      );
    },
    async decline(userId) {
      await http(
        `/social/requests/${player(userId)}/decline`,
        "POST",
        [204],
        (v) => v === undefined,
      );
    },
    async remove(userId) {
      await http(
        `/social/friends/${player(userId)}`,
        "DELETE",
        [204],
        (v) => v === undefined,
      );
    },
    async block(userId) {
      await http(
        `/social/blocks/${player(userId)}`,
        "PUT",
        [204],
        (v) => v === undefined,
      );
    },
    async unblock(userId) {
      await http(
        `/social/blocks/${player(userId)}`,
        "DELETE",
        [204],
        (v) => v === undefined,
      );
    },
  });
  return {
    time: () =>
      http<PlatformTime>(
        "/time",
        "GET",
        [200],
        shape({ now: str, epochMs: (v) => Number.isSafeInteger(v) }),
        undefined,
        false,
      ),
    social,
    board(nameOrId) {
      const path = `/lb/${segment(nameOrId)}`;
      return protect<PlatformBoard>({
        async info() {
          return http<PlatformBoardInfo>(
            path,
            "GET",
            [200],
            shape({
              id: str,
              name: str,
              submit: (v) => v === "owner" || v === "server",
              rule: (v) => ["best", "latest", "sum"].includes(v as string),
              order: (v) => v === "asc" || v === "desc",
              maxEntries: int,
              periods: array(shape(bucket)),
            }),
          );
        },
        async submit({ score: value, meta }) {
          if (
            !Number.isSafeInteger(value) ||
            (meta !== undefined &&
              (typeof meta !== "string" ||
                new TextEncoder().encode(meta).length > 1024))
          )
            throw invalid("Invalid board score");
          return http(
            `${path}/scores/me`,
            "PUT",
            [200],
            shape({
              submitted: num,
              periods: array(shape({ ...bucket, score: num, updatedAt: int })),
            }),
            { score: value, ...(meta === undefined ? {} : { meta }) },
          );
        },
        async top({ period: value, limit = 50, offset = 0 }) {
          periodOf(value);
          if (
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 100 ||
            !Number.isInteger(offset) ||
            offset < 0 ||
            offset > 1000
          )
            throw invalid("Invalid board pagination");
          return http<PlatformBoardPage>(
            `${path}/top?${new URLSearchParams({ period: value, limit: String(limit), offset: String(offset) }).toString()}`,
            "GET",
            [200],
            shape({
              ...bucket,
              total: int,
              entries: array(shape({ ...score, owner: str })),
            }),
          );
        },
        async me(value) {
          periodOf(value);
          try {
            return await http<PlatformBoardOwnScore>(
              `${path}/scores/me?${new URLSearchParams({ period: value }).toString()}`,
              "GET",
              [200],
              shape({ ...bucket, ...score, total: int, owner: str }),
            );
          } catch (e) {
            if (isPlatformClientError(e) && e.status === 404) return undefined;
            throw e;
          }
        },
      });
    },
  };
}
export function createPlatformPresenceClient(
  options: PlatformPresenceClientOptions,
): PlatformPresenceClient {
  const http = createHttp(options);
  const channel = segment(options.channelId);
  return protect<PlatformPresenceClient>({
    async users(ids) {
      return (
        await http<{ users: PlatformPresence[] }>(
          `/presence?${new URLSearchParams({ channel, users: batch(ids) }).toString()}`,
          "GET",
          [200],
          shape({
            type: (v) => v === "presence",
            users: array(shape({ userId: str, online: bool })),
          }),
        )
      ).users;
    },
  });
}
