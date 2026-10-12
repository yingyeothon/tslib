import {
  createFakeState,
  createFakeGameGateway,
  fakeResponse,
  type FakeRequest,
  type FakeResponse,
} from "./game-kit-fakes.js";
/** Structural state/match doubles sharing one auth map; no engine or FCM SDK. */
export function createFakePlatform(now: () => number = () => 1700000000000) {
  const state = createFakeState({ now });
  const gateway = createFakeGameGateway();
  const tokens = new Map<string, string>();
  const profiles = new Map<
    string,
    {
      owner: string;
      displayName: string;
      avatar: string | null;
      updatedAt: number;
    }
  >();
  const requests = new Map<string, string>();
  const friends = new Set<string>();
  const blocks = new Set<string>();
  const online = new Set<string>();
  const scores = new Map<
    string,
    Map<string, { score: number; meta: string | null; updatedAt: number }>
  >();
  const boards = new Map<
    string,
    {
      submit: "owner" | "server";
      rule: "best" | "latest" | "sum";
      order: "asc" | "desc";
      periods: ("alltime" | "daily" | "weekly")[];
    }
  >();
  const tickets = new Map<string, Record<string, unknown>>();
  const cooldowns = new Map<string, number>();
  const matchSockets: MatchSocket[] = [];
  const pushes = new Map<string, string>();
  const calls: Array<{ url: string; request: FakeRequest }> = [];
  let next = 0;
  let refusal:
    { status: number; reason?: string; retryAfter?: number } | undefined;
  const fail = (status: number, reason?: string, retryAfter?: number) =>
    fakeResponse(status, {
      error: {
        code:
          status === 409
            ? "conflict"
            : status === 429
              ? "rate_limited"
              : status === 401
                ? "unauthorized"
                : "bad_request",
        details: { reason, retryAfter },
      },
    });
  const rel = (id: string) => ({
    ...profiles.get(id),
    owner: id,
    displayName: profiles.get(id)?.displayName ?? null,
    avatar: profiles.get(id)?.avatar ?? null,
    since: Math.floor(now() / 1000),
  });
  const bucket = (period: string) => ({
    period,
    periodKey: period === "alltime" ? "" : "server-period",
    periodEndsAt: period === "alltime" ? null : Math.floor(now() / 1000) + 3600,
  });
  function matchReady() {
    const waiting = [...tickets].filter(([, t]) => t.state === "waiting");
    if (waiting.length < 2) return;
    const matchId = `match_${++next}`;
    for (const [id] of waiting.slice(0, 2))
      tickets.set(id, {
        state: "proposed",
        matchId,
        acceptBy: Math.floor(now() / 1000) + 30,
        accepted: false,
        partial: false,
      });
  }
  function handle(urlText: string, request: FakeRequest): FakeResponse {
    const url = new URL(urlText);
    const path = url.pathname;

    const id = tokens.get(
      (
        request.headers.Authorization ??
        request.headers.authorization ??
        ""
      ).slice(7),
    );
    if (!id) return fail(401);
    if (refusal)
      return fail(refusal.status, refusal.reason, refusal.retryAfter);
    const body = request.body
      ? (JSON.parse(request.body) as Record<string, unknown>)
      : {};
    if (path.startsWith("/lb/")) {
      const parts = path.split("/");
      const name = parts[2]!;
      const board = boards.get(name);
      if (!board) return fail(404);
      const rows = scores.get(name)!;
      const period = url.searchParams.get("period") ?? "alltime";
      const ranked = [...rows]
        .sort((a, b) =>
          board.order === "asc"
            ? a[1].score - b[1].score
            : b[1].score - a[1].score,
        )
        .map(([owner, s], index, all) => ({
          ...s,
          owner,
          rank:
            1 +
            all.filter(([, other]) =>
              board.order === "asc"
                ? other.score < s.score
                : other.score > s.score,
            ).length,
          index,
        }));
      if (parts.length === 3)
        return fakeResponse(200, {
          id: name,
          name,
          ...board,
          maxEntries: 2000,
          periods: board.periods.map(bucket),
        });
      if (parts[3] === "top") {
        const offset = Number(url.searchParams.get("offset") ?? 0),
          limit = Number(url.searchParams.get("limit") ?? 50);
        return fakeResponse(200, {
          ...bucket(period),
          total: ranked.length,
          entries: ranked.slice(offset, offset + limit),
        });
      }
      if (request.method === "GET") {
        const score = ranked.find((s) => s.owner === id);
        return score
          ? fakeResponse(200, {
              ...bucket(period),
              ...score,
              total: ranked.length,
            })
          : fail(404);
      }
      if (board.submit === "server") return fail(403, "server_only");
      const previous = rows.get(id);
      const incoming = body.score as number;
      const value =
        board.rule === "sum"
          ? (previous?.score ?? 0) + incoming
          : board.rule === "best" && previous
            ? (board.order === "asc" ? Math.min : Math.max)(
                previous.score,
                incoming,
              )
            : incoming;
      rows.set(id, {
        score: value,
        meta: (body.meta as string) ?? null,
        updatedAt: Math.floor(now() / 1000),
      });
      return fakeResponse(200, {
        submitted: incoming,
        periods: board.periods.map((p) => ({
          ...bucket(p),
          score: value,
          updatedAt: Math.floor(now() / 1000),
        })),
      });
    }
    if (path === "/presence")
      return fakeResponse(200, {
        type: "presence",
        users: (url.searchParams.get("users") ?? "")
          .split(",")
          .map((userId) => ({ userId, online: online.has(userId) })),
      });
    if (path === "/social/me/profile") {
      if (request.method === "GET")
        return profiles.has(id)
          ? fakeResponse(200, profiles.get(id))
          : fail(404);
      const created = !profiles.has(id);
      const p = {
        owner: id,
        displayName: body.displayName as string,
        avatar: (body.avatar as string) ?? null,
        updatedAt: Math.floor(now() / 1000),
      };
      profiles.set(id, p);
      return fakeResponse(created ? 201 : 200, p);
    }
    if (path === "/social/profiles")
      return fakeResponse(200, {
        profiles: (url.searchParams.get("ids") ?? "")
          .split(",")
          .flatMap((user) => (profiles.has(user) ? [profiles.get(user)] : [])),
      });
    if (path === "/social/friends")
      return fakeResponse(200, {
        friends: [...friends]
          .filter((key) => key.startsWith(`${id}:`))
          .map((key) => rel(key.slice(id.length + 1))),
      });
    if (path === "/social/requests" && request.method === "GET")
      return fakeResponse(200, {
        incoming: [...requests]
          .filter(
            ([key, state]) => key.endsWith(`:${id}`) && state === "requested",
          )
          .map(([key]) => rel(key.split(":")[0]!)),
        outgoing: [...requests]
          .filter(([key]) => key.startsWith(`${id}:`))
          .map(([key]) => rel(key.split(":")[1]!)),
      });
    if (path === "/social/requests") {
      const to = body.to as string;
      if (
        !profiles.has(to) ||
        blocks.has(`${to}:${id}`) ||
        blocks.has(`${id}:${to}`)
      )
        return fail(404);
      requests.set(`${id}:${to}`, "requested");
      return fakeResponse(201, { state: "requested" });
    }
    const social =
      /^\/social\/(requests|friends|blocks)\/([^/]+)(?:\/(accept|decline))?$/.exec(
        path,
      );
    if (social) {
      const [, kind, other, action] = social;
      if (kind === "blocks") {
        if (request.method === "PUT") {
          blocks.add(`${id}:${other}`);
          requests.delete(`${other}:${id}`);
          friends.delete(`${id}:${other}`);
          friends.delete(`${other}:${id}`);
        } else blocks.delete(`${id}:${other}`);
      } else if (kind === "friends") {
        friends.delete(`${id}:${other}`);
        friends.delete(`${other}:${id}`);
      } else if (action === "accept") {
        requests.delete(`${other}:${id}`);
        friends.add(`${id}:${other}`);
        friends.add(`${other}:${id}`);
      } else requests.set(`${other}:${id}`, "dropped");
      return fakeResponse(204);
    }
    if (path.startsWith("/push/")) {
      if (request.method === "PUT") pushes.set(body.token as string, id);
      else if (pushes.get(body.token as string) === id)
        pushes.delete(body.token as string);
      return fakeResponse(204);
    }
    if (path.startsWith("/m/")) {
      const action = path.split("/")[3];
      let ticket = tickets.get(id);
      if (action === "ticket" && request.method === "POST") {
        const cooldown = cooldowns.get(id) ?? 0;
        if (cooldown > now())
          return fail(429, "cooldown", Math.ceil((cooldown - now()) / 1000));
        if (ticket?.state === "proposed") return fail(409, "proposed");
        tickets.set(id, { state: "waiting", position: 1, waited: 0 });
        matchReady();
        return fakeResponse(200, tickets.get(id));
      }
      if (action === "ticket" && request.method === "DELETE") {
        if (ticket?.state === "proposed")
          for (const [other, t] of tickets)
            if (t.matchId === ticket.matchId && other !== id)
              tickets.set(other, { state: "waiting", position: 1, waited: 0 });
        tickets.delete(id);
        return fakeResponse(204);
      }
      if (!ticket) return fail(404);
      if (action === "accept") {
        if (ticket.state === "proposed") {
          ticket.accepted = true;
          const members = [...tickets].filter(
            ([, t]) => t.matchId === ticket!.matchId,
          );
          if (members.every(([, t]) => t.accepted))
            for (const [user] of members)
              tickets.set(user, {
                state: "confirmed",
                matchId: ticket.matchId,
                partial: false,
                result: null,
                members: members.map(([userId]) => ({ userId })),
              });
        }
        return fakeResponse(200, tickets.get(id));
      }
      if (action === "decline") {
        for (const [other, t] of tickets)
          if (t.matchId === ticket.matchId && other !== id)
            tickets.set(other, { state: "waiting", position: 1, waited: 0 });
        ticket = { state: "declined", matchId: ticket.matchId };
        tickets.set(id, ticket);
        cooldowns.set(id, now() + 5000);
      }
      return fakeResponse(200, ticket);
    }
    return fail(404);
  }
  class MatchSocket {
    readyState = 1;
    protocol = "bearer";
    readonly id: string;
    handlers = new Map<string, Array<(event: never) => void>>();
    constructor(_url: string, protocols: string[]) {
      this.id = tokens.get(protocols[1] ?? "") ?? "";
      matchSockets.push(this);
    }
    addEventListener(type: string, handler: (event: never) => void) {
      const list = this.handlers.get(type) ?? [];
      list.push(handler);
      this.handlers.set(type, list);
    }
    send(_data: string) {}
    close() {
      this.readyState = 3;
    }
    receive(frame: unknown) {
      if (this.readyState === 3) return;
      for (const handler of this.handlers.get("message") ?? [])
        handler({ data: JSON.stringify(frame) } as never);
    }
  }
  return {
    state,
    gateway,
    calls,
    profiles,
    online,
    pushes,
    fetch: (url: string, request: FakeRequest): Promise<FakeResponse> => {
      calls.push({ url, request });
      const path = new URL(url).pathname;
      if (path === "/time" || path.includes("/c/") || path.startsWith("/kv/"))
        return state.fetch(url, request);
      return Promise.resolve(handle(url, request));
    },
    register(userId: string) {
      const token = state.register(userId);
      tokens.set(token, userId);
      gateway.register(userId, token);
      return token;
    },
    board(
      name: string,
      config: Partial<{
        submit: "owner" | "server";
        rule: "best" | "latest" | "sum";
        order: "asc" | "desc";
        periods: ("alltime" | "daily" | "weekly")[];
      }> = {},
    ) {
      boards.set(name, {
        submit: "owner",
        rule: "best",
        order: "desc",
        periods: ["alltime", "daily", "weekly"],
        ...config,
      });
      scores.set(name, new Map());
    },
    MatchWebSocket: MatchSocket,
    match(ids: string[], extra: Record<string, unknown> = {}) {
      const result = {
        type: "matched",
        matchId: `match_${++next}`,
        partial: false,
        result: null,
        members: ids.map((userId) => ({ userId })),
        ...extra,
      };
      for (const s of matchSockets) if (ids.includes(s.id)) s.receive(result);
    },
    setTicket(userId: string, ticket: Record<string, unknown>) {
      tickets.set(userId, ticket);
    },
    setRefusal(value?: typeof refusal) {
      refusal = value;
    },
  };
}
