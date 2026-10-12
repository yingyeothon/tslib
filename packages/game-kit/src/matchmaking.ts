import type { RoomInvitation } from "./types.js";
import {
  createDeferredMatchClient,
  createLiveMatchClient,
  isPlatformClientError,
  type MatchTicket,
  type MatchResult,
  type LiveMatchClient,
} from "@yingyeothon/platform-client";
import { emitter, kitError, mapError, type Runtime } from "./runtime.js";
import type { RoomControl } from "./room.js";
import type { Matchmaking } from "./extended-types.js";
export function createMatchmaking(runtime: Runtime, room: RoomControl) {
  const events = emitter();
  let epoch = 0;
  let active = false;
  let live: LiveMatchClient | undefined;
  let timer = () => {};
  let lastRead = -Infinity;
  let nextDelay = runtime.options.matchmaking?.pollIntervalMs ?? 4000;
  const interval = nextDelay;
  if (!Number.isFinite(interval) || interval < 1000)
    throw new RangeError("matchmaking pollIntervalMs must be at least 1000");
  let lastTicket = "";
  let reading:
    { epoch: number; task: Promise<MatchTicket | undefined> } | undefined;
  const waiters = new Set<() => void>();
  const valid = (mine: number, generation: number) =>
    mine === epoch && generation === runtime.generation && !runtime.disposed;
  function stop() {
    epoch++;
    active = false;
    timer();
    timer = () => {};
    live?.cancel();
    live = undefined;
    for (const cancel of [...waiters]) cancel();
    waiters.clear();
    reading = undefined;
    lastTicket = "";
    lastRead = -Infinity;
    nextDelay = interval;
  }
  for (const event of ["stop", "change", "dispose"])
    runtime.events.on(event, stop);
  function cfg() {
    const config = runtime.options.config.match;
    if (!config) throw kitError("matchmaking", "not_configured");
    return config;
  }
  function deferred() {
    const config = cfg();
    if (config.mode !== "deferred")
      throw kitError("matchmaking", "invalid_state");
    if (!runtime.identity || runtime.disposed)
      throw kitError("matchmaking", "signed_out");
    return createDeferredMatchClient({
      baseUrl: config.apiBase,
      channelId: config.channelId,
      token: runtime.identity.token,
      fetch: runtime.options.fetch,
    });
  }
  function pause(ms: number, mine: number, generation: number): Promise<void> {
    if (!valid(mine, generation))
      return Promise.reject(kitError("matchmaking", "cancelled"));
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cancel = runtime.clock.schedule(() => {
        waiters.delete(abort);
        if (!valid(mine, generation))
          reject(kitError("matchmaking", "cancelled"));
        else resolve();
      }, ms);
      const abort = () => {
        cancel();
        waiters.delete(abort);
        reject(kitError("matchmaking", "cancelled"));
      };
      waiters.add(abort);
    });
  }
  function publish(
    ticket: MatchTicket | undefined,
    mine: number,
    generation: number,
  ) {
    if (!valid(mine, generation)) throw kitError("matchmaking", "cancelled");
    active = ticket?.state === "waiting" || ticket?.state === "proposed";
    const key = JSON.stringify(ticket);
    if (ticket && key !== lastTicket) {
      lastTicket = key;
      events.emit("stateChanged", ticket, () => valid(mine, generation));
    }
    arm();
  }
  async function read(automatic = false): Promise<MatchTicket | undefined> {
    cfg();
    if (reading?.epoch === epoch) return reading.task;
    const mine = epoch,
      generation = runtime.generation;
    const c = deferred();
    const task = runtime.run("matchmaking", async () => {
      await pause(
        Math.max(0, 1000 - (runtime.clock.now() - lastRead)),
        mine,
        generation,
      );
      if (!valid(mine, generation)) throw kitError("matchmaking", "cancelled");
      if (automatic && !runtime.foreground)
        throw kitError("matchmaking", "cancelled");
      lastRead = runtime.clock.now();
      const ticket = await c.status();
      if (!automatic || runtime.foreground) publish(ticket, mine, generation);
      return ticket;
    });
    reading = { epoch: mine, task };
    try {
      return await task;
    } finally {
      if (reading?.task === task) reading = undefined;
    }
  }
  function arm(delay = interval) {
    timer();
    if (active && runtime.foreground && runtime.identity && !runtime.disposed)
      timer = runtime.clock.schedule(wake, delay);
  }
  function wake(discover = false) {
    timer();
    if (
      runtime.options.config.match?.mode !== "deferred" ||
      !runtime.foreground ||
      !runtime.identity ||
      runtime.disposed
    )
      return;
    if (discover) active = true;
    if (!active) return;
    const mine = epoch,
      generation = runtime.generation;
    runtime.background(
      "matchmaking",
      read(true).then(
        () => {
          if (valid(mine, generation)) {
            nextDelay = interval;
            arm();
          }
        },
        (error) => {
          if (valid(mine, generation)) {
            arm(nextDelay);
            nextDelay = Math.min(30000, nextDelay * 2);
          }
          throw error;
        },
      ),
    );
  }
  runtime.events.on("foreground", () => {
    timer();
    if (runtime.foreground) wake(true);
  });
  async function perform(
    action: "submit" | "accept" | "decline",
    mine = epoch,
  ): Promise<MatchTicket> {
    const generation = runtime.generation;
    const c = deferred();
    let delay = interval;
    return runtime.run("matchmaking", async () => {
      for (;;) {
        if (!valid(mine, generation))
          throw kitError("matchmaking", "cancelled");
        try {
          const result = await c[action]();
          publish(result, mine, generation);
          arm();
          return result;
        } catch (error) {
          if (!valid(mine, generation))
            throw kitError("matchmaking", "cancelled");
          if (isPlatformClientError(error)) {
            if (
              [
                "proposed",
                "proposal_closed",
                "not_proposed",
                "confirmed",
              ].includes(error.reason ?? "")
            ) {
              const ticket = await read();
              if (ticket) return ticket;
              throw kitError("matchmaking", "proposal_closed");
            }
            const retry =
              error.reason === "cooldown"
                ? error.retryAfterMs
                : error.reason === "confirming"
                  ? 1500
                  : error.status === 429 || error.status === 503
                    ? delay
                    : undefined;
            if (retry !== undefined) {
              await pause(Math.max(1000, retry), mine, generation);
              delay = Math.min(30000, delay * 2);
              continue;
            }
          }
          throw error;
        }
      }
    });
  }
  async function formRoom(
    result: MatchResult,
    mine: number,
    generation: number,
    early: RoomInvitation[],
  ): Promise<MatchResult> {
    if (runtime.options.matchmaking?.callback) return result;
    const ids = new Set(result.members.map((m) => m.userId));
    const userId = runtime.identity!.userId;
    if (!ids.has(userId) || !ids.size)
      throw kitError("matchmaking", "unavailable");
    const leader = [...ids].sort()[0]!;
    return new Promise<MatchResult>((resolve, reject) => {
      let finished = false;
      const cleanups: Array<() => void> = [];
      const complete = (partial: boolean, error?: unknown) => {
        if (finished) return;
        finished = true;
        for (const off of cleanups) off();
        waiters.delete(abort);
        if (error) reject(mapError("matchmaking", error));
        else
          resolve({
            ...result,
            partial: result.partial || partial,
            members: partial
              ? result.members.filter((m) =>
                  room.room.members.some((r) => r.userId === m.userId),
                )
              : result.members,
          });
      };
      const abort = () => complete(true, kitError("matchmaking", "cancelled"));
      waiters.add(abort);
      const check = () => {
        if (!valid(mine, generation)) {
          abort();
          return;
        }
        if (
          room.room.id &&
          [...ids].every((id) => room.room.members.some((m) => m.userId === id))
        )
          complete(false);
      };
      for (const event of ["memberJoined", "memberLeft"])
        cleanups.push(room.room.on(event, check));
      const accepted = new Set<string>();
      const accept = (invite: RoomInvitation) => {
        const key = `${invite.from}:${invite.roomId}`;
        if (
          !finished &&
          valid(mine, generation) &&
          ids.has(invite.from) &&
          !accepted.has(key)
        ) {
          accepted.add(key);
          runtime.background("matchmaking", invite.accept().then(check));
        }
      };
      cleanups.push(room.room.on("invited", accept));
      for (const invite of early) accept(invite);
      cleanups.push(runtime.clock.schedule(() => complete(true), 30000));
      if (userId === leader)
        runtime.background(
          "matchmaking",
          room.room
            .create()
            .then(async () => {
              if (!valid(mine, generation) || finished) return;
              for (const id of ids) {
                if (!valid(mine, generation) || finished) return;
                if (id !== userId)
                  try {
                    await room.room.invite(id);
                  } catch (error) {
                    runtime.logger.warn("matched member could not join", {
                      module: "matchmaking",
                      code: mapError("matchmaking", error).code,
                    });
                  }
              }
              check();
            })
            .catch((error) => complete(true, mapError("matchmaking", error))),
        );
      else check();
    });
  }
  const matchmaking: Matchmaking = {
    async find(options = {}) {
      const config = cfg();
      if (config.mode === "deferred")
        throw kitError("matchmaking", "invalid_state");
      if (!runtime.identity || runtime.disposed)
        throw kitError("matchmaking", "signed_out");
      if (!room.connected) throw kitError("matchmaking", "lobby_required");
      if (
        options.timeoutMs !== undefined &&
        (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
      )
        throw new RangeError("Invalid match timeoutMs");
      stop();
      const mine = epoch,
        generation = runtime.generation;
      const client = createLiveMatchClient({
        url: config.url,
        channelId: config.channelId,
        token: runtime.identity.token,
        WebSocket: runtime.options.WebSocket,
      });
      live = client;
      const invitations: Array<{ invite: RoomInvitation; at: number }> = [];
      const stopBuffer = room.room.on("invited", (invite) => {
        if (!valid(mine, generation)) return;
        if (invitations.length >= 50) invitations.shift();
        invitations.push({ invite, at: runtime.clock.now() });
      });
      let cancelDeadline = () => {};
      try {
        const task = runtime.run("matchmaking", async () => {
          const result = await client.find();
          if (!valid(mine, generation))
            throw kitError("matchmaking", "cancelled");
          stopBuffer();
          return formRoom(
            result,
            mine,
            generation,
            invitations
              .filter((v) => runtime.clock.now() - v.at <= 30000)
              .map((v) => v.invite),
          );
        });
        if (options.timeoutMs !== undefined)
          cancelDeadline = runtime.clock.schedule(() => {
            if (valid(mine, generation)) stop();
          }, options.timeoutMs);
        return await task;
      } finally {
        stopBuffer();
        cancelDeadline();
        if (live === client) {
          client.cancel();
          live = undefined;
        }
      }
    },
    async submit() {
      cfg();
      stop();
      return perform("submit");
    },
    status() {
      return read();
    },
    async cancel() {
      const config = cfg();
      const c = config.mode === "deferred" ? deferred() : undefined;
      stop();
      if (!c) return;
      const mine = epoch,
        generation = runtime.generation;
      let delay = interval;
      await runtime.run("matchmaking", async () => {
        for (;;) {
          if (!valid(mine, generation))
            throw kitError("matchmaking", "cancelled");
          try {
            await c.cancel();
            return;
          } catch (error) {
            if (!valid(mine, generation))
              throw kitError("matchmaking", "cancelled");
            if (
              isPlatformClientError(error) &&
              (error.reason === "confirming" ||
                error.status === 429 ||
                error.status === 503)
            ) {
              await pause(
                error.reason === "confirming" ? 1500 : delay,
                mine,
                generation,
              );
              delay = Math.min(30000, delay * 2);
              continue;
            }
            throw error;
          }
        }
      });
    },
    accept() {
      return perform("accept");
    },
    decline() {
      return perform("decline");
    },
    on(_event, handler) {
      cfg();
      return events.on("stateChanged", (value) =>
        handler(value as MatchTicket),
      );
    },
  };
  runtime.events.on("dispose", () => events.clear());
  return { matchmaking, wake: () => wake(true) };
}
