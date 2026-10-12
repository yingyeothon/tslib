import {
  createPlatformClient,
  createPlatformPresenceClient,
  type PlatformProfile,
} from "@yingyeothon/platform-client";
import { emitter, kitError, type Runtime } from "./runtime.js";
import { createPoller } from "./polling.js";
import type { Friends } from "./extended-types.js";
import type { Room } from "./types.js";
export function createFriends(runtime: Runtime, room: Room): Friends {
  const events = emitter();
  let listeners = 0;
  let seen = new Set<string>();
  const cache = new Map<string, { until: number; value: PlatformProfile }>();
  function client() {
    const baseUrl = runtime.options.config.state?.url;
    if (!baseUrl) throw kitError("friends", "not_configured");
    if (!runtime.identity || runtime.disposed)
      throw kitError("friends", "signed_out");
    return createPlatformClient({
      baseUrl,
      token: runtime.identity.token,
      fetch: runtime.options.fetch,
    }).social;
  }
  function presence() {
    const gateway = runtime.options.config.gateway;
    if (!gateway) throw kitError("friends", "not_configured");
    const baseUrl = new URL(gateway.url);
    baseUrl.protocol = baseUrl.protocol === "wss:" ? "https:" : "http:";
    return createPlatformPresenceClient({
      baseUrl: baseUrl.href,
      channelId: gateway.lobbyChannelId,
      token: runtime.identity!.token,
      fetch: runtime.options.fetch,
    });
  }
  const run = async <T>(action: () => Promise<T>) => {
    client();
    return runtime.run("friends", action);
  };
  const friends: Friends = {
    list() {
      return run(async () => {
        const generation = runtime.generation;
        const relations = await client().friends();
        const statuses = new Map<string, boolean>();
        for (let i = 0; i < relations.length; i += 50) {
          if (generation !== runtime.generation)
            throw kitError("friends", "signed_out");
          for (const p of await presence().users(
            relations.slice(i, i + 50).map((r) => r.owner),
          ))
            statuses.set(p.userId, p.online);
        }
        return relations.map((r) => ({
          userId: r.owner,
          profile: { displayName: r.displayName, avatar: r.avatar },
          online: statuses.get(r.owner) ?? false,
        }));
      });
    },
    requests() {
      return run(() => client().requests());
    },
    request(userId) {
      return run(async () => {
        await client().request(userId);
      });
    },
    accept(userId) {
      return run(() => client().accept(userId));
    },
    decline(userId) {
      return run(() => client().decline(userId));
    },
    remove(userId) {
      return run(() => client().remove(userId));
    },
    block(userId) {
      return run(() => client().block(userId));
    },
    unblock(userId) {
      return run(() => client().unblock(userId));
    },
    profiles(ids) {
      return run(async () => {
        const c = client();
        const generation = runtime.generation;
        const unique = [...new Set(ids)];
        const missing = unique.filter(
          (id) => (cache.get(id)?.until ?? 0) <= runtime.clock.now(),
        );
        for (let i = 0; i < missing.length; i += 50) {
          if (generation !== runtime.generation)
            throw kitError("friends", "signed_out");
          const profiles = await c.profiles(missing.slice(i, i + 50));
          if (generation !== runtime.generation)
            throw kitError("friends", "signed_out");
          for (const p of profiles)
            cache.set(p.owner, {
              until: runtime.clock.now() + 30000,
              value: p,
            });
        }
        return unique.flatMap((id) => {
          const p = cache.get(id);
          return p && p.until > runtime.clock.now() ? [p.value] : [];
        });
      });
    },
    profile: {
      me: () => run(() => client().profile()),
      set: (options) =>
        run(async () => {
          const generation = runtime.generation;
          const p = await client().setProfile(options);
          if (generation !== runtime.generation)
            throw kitError("friends", "signed_out");
          cache.delete(p.owner);
          return p;
        }),
    },
    invite(userId) {
      return run(async () => {
        const generation = runtime.generation;
        const online = await presence().users([userId]);
        if (generation !== runtime.generation)
          throw kitError("friends", "signed_out");
        if (!online[0]?.online) throw kitError("friends", "offline");
        await room.invite(userId);
      });
    },
    on(_event, handler) {
      client();
      listeners++;
      const off = events.on("requested", (v) => handler(v as string));
      poll.wake();
      return () => {
        off();
        listeners--;
        if (!listeners) poll.stop();
      };
    },
  };
  const poll = createPoller(
    runtime,
    "friends",
    runtime.options.friends?.pollIntervalMs ?? 30000,
    async () => {
      const generation = runtime.generation;
      const requests = await friends.requests();
      if (generation !== runtime.generation || !runtime.foreground) return;
      const next = new Set(requests.incoming.map((r) => r.owner));
      const arrived = requests.incoming.filter((r) => !seen.has(r.owner));
      seen = next;
      for (const r of arrived) {
        if (generation !== runtime.generation || !runtime.foreground) break;
        events.emit(
          "requested",
          r.owner,
          () => generation === runtime.generation && runtime.foreground,
        );
      }
    },
    () => listeners > 0,
  );
  for (const name of ["stop", "change", "dispose"])
    runtime.events.on(name, () => {
      cache.clear();
      seen.clear();
      if (name === "dispose") {
        events.clear();
        listeners = 0;
      }
    });
  return friends;
}
