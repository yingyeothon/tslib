/** In-process protocol doubles, not servers or production JWT verification. */
export interface FakeRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
}
export interface FakeResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export function fakeResponse(
  status: number,
  body: unknown = "",
  headers: Record<string, string> = {},
): FakeResponse {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: () =>
      Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  };
}
export function fakeToken(userId: string, exp = 2000000000): string {
  return `e30.${Buffer.from(JSON.stringify({ sub: userId, exp })).toString("base64url")}.signature`;
}
export function createFakeScheduler() {
  let now = 0;
  let id = 0;
  const tasks = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    schedule(run: () => void, delayMs: number) {
      const key = ++id;
      tasks.set(key, { at: now + delayMs, run });
      return () => {
        tasks.delete(key);
      };
    },
    advance(ms: number) {
      const end = now + ms;
      let count = 0;
      for (;;) {
        const next = [...tasks.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        if (++count > 10000) throw new Error("fake scheduler loop");
        now = next[1].at;
        tasks.delete(next[0]);
        next[1].run();
      }
      now = end;
    },
    get pendingCount() {
      return tasks.size;
    },
  };
}
export interface FakeCollection {
  readScope: "project" | "user";
  writeScope: "user" | "server" | "team";
  versions: Map<string, number>;
  rows: Map<
    string,
    {
      value: string;
      version: number;
      expiresAt?: number;
      from: string;
      at: number;
    }
  >;
}
export function createFakeState(options: { now?: () => number } = {}) {
  const collections = new Map<string, FakeCollection>();
  const tokens = new Map<string, string>();
  const requests: { path: string; method: string; body?: string }[] = [];
  let online = true;
  let refusal: number | undefined;
  const now = options.now ?? (() => 1700000000000);
  function fail(
    status: number,
    code: string,
    details?: Record<string, unknown>,
  ) {
    return fakeResponse(status, {
      error: { code, ...(details ? { details } : {}) },
    });
  }
  function handle(url: string, request: FakeRequest): FakeResponse {
    if (!online) throw new Error("fake network offline");
    const u = new URL(url);
    requests.push({
      path: u.pathname,
      method: request.method,
      body: request.body,
    });
    if (refusal)
      return fail(refusal, refusal === 401 ? "unauthorized" : "unavailable");
    if (u.pathname === "/time")
      return fakeResponse(200, {
        epochMs: now(),
        now: new Date(now()).toISOString(),
      });
    if (u.pathname.endsWith("/.well-known/config"))
      return fakeResponse(200, {
        issuer: "test",
        audience: "game",
        providers: ["github"],
        startUrl: "https://auth.invalid/c/ch/start",
        redirectAllowlist: ["https://game.invalid/callback"],
        tokenTtlSec: 86400,
      });
    const token = request.headers.authorization?.slice(7);
    const userId = token ? tokens.get(token) : undefined;
    if (u.pathname.endsWith("/verify"))
      return userId
        ? fakeResponse(200, {
            userId,
            exp: (
              JSON.parse(
                Buffer.from(token!.split(".")[1]!, "base64url").toString(),
              ) as { exp: number }
            ).exp,
          })
        : fail(401, "unauthorized");
    if (!userId) return fail(401, "unauthorized");
    const route =
      /^\/kv\/([^/]+)(?:\/u\/([^/]+))?(?:\/entries(?:\/([^/]+))?)?$/.exec(
        u.pathname,
      );
    if (!route) return fail(404, "not_found");
    const [, name, rawOwner, key] = route;
    const col = collections.get(name!);
    if (!col) return fail(404, "not_found");
    if (!u.pathname.includes("/entries"))
      return fakeResponse(200, {
        id: name,
        name,
        readScope: col.readScope,
        writeScope: col.writeScope,
        encrypted: false,
        maxEntries: 10000,
        maxEntriesPerOwner: 10000,
      });
    const perOwner = col.readScope === "user" || col.writeScope === "user";
    const owner = rawOwner === "me" ? userId : rawOwner;
    if (perOwner !== (owner !== undefined))
      return fail(400, "bad_request", { reason: "wrong_namespace" });
    if (perOwner && owner !== userId) return fail(403, "forbidden");
    const prefix = `${owner ?? ""}:`;
    const id = prefix + (key ?? "");
    const time = Math.floor(now() / 1000);
    const stored = col.rows.get(id);
    const row =
      stored && (stored.expiresAt === undefined || stored.expiresAt > time)
        ? stored
        : undefined;
    if (!key) {
      const entries = [...col.rows]
        .filter(
          ([k, r]) =>
            k.startsWith(prefix) &&
            (r.expiresAt === undefined || r.expiresAt > time) &&
            k
              .slice(prefix.length)
              .startsWith(u.searchParams.get("prefix") ?? ""),
        )
        .map(([k, r]) => ({
          key: k.slice(prefix.length),
          version: r.version,
          bytes: Buffer.byteLength(r.value),
          updatedAt: r.at,
          ...(perOwner ? { from: r.from } : {}),
          ...(u.searchParams.get("values") === "1"
            ? { valueText: r.value }
            : {}),
        }));
      return fakeResponse(200, { entries });
    }
    if (request.method === "GET")
      return row
        ? fakeResponse(200, row.value, {
            etag: `"${row.version}"`,
            ...(perOwner
              ? { "x-kv-from": row.from, "x-kv-at": String(row.at) }
              : {}),
            ...(row.expiresAt === undefined
              ? {}
              : { "x-kv-expires-at": String(row.expiresAt) }),
          })
        : fail(404, "not_found");
    if (col.writeScope !== "user") return fail(403, "forbidden");
    const ifMatch = request.headers["if-match"];
    if (
      (ifMatch && ifMatch !== `"${row?.version}"`) ||
      (request.headers["if-none-match"] === "*" && row)
    )
      return fail(409, "conflict", { current: row?.version ?? null });
    if (request.method === "DELETE") {
      if (!row) return fail(404, "not_found");
      col.rows.delete(id);
      return fakeResponse(204);
    }
    let value = request.body ?? "null";
    if (request.method === "PATCH") {
      const patch = JSON.parse(value) as {
        incr: number;
        min?: number;
        max?: number;
      };
      const base = row ? (JSON.parse(row.value) as number) : 0;
      if (!Number.isSafeInteger(base))
        return fail(409, "conflict", { reason: "not_a_number" });
      const next = base + patch.incr;
      if (!Number.isSafeInteger(next))
        return fail(409, "conflict", { reason: "overflow" });
      if (
        (patch.min !== undefined && next < patch.min) ||
        (patch.max !== undefined && next > patch.max)
      )
        return fail(409, "conflict", { reason: "out_of_range", value: base });
      value = JSON.stringify(next);
    } else if (request.method !== "PUT") return fail(405, "method_not_allowed");
    if (Buffer.byteLength(value) > 16384) return fail(413, "payload_too_large");
    const ttl = u.searchParams.get("ttl");
    const expiresAt =
      ttl === null
        ? stored?.expiresAt
        : Number(ttl) === 0
          ? undefined
          : time + Number(ttl);
    const version = (stored?.version ?? col.versions.get(id) ?? 0) + 1;
    col.versions.set(id, version);
    col.rows.set(id, {
      value,
      version,
      from: userId,
      at: time,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    const headers = {
      etag: `"${version}"`,
      ...(ttl && expiresAt ? { "x-kv-expires-at": String(expiresAt) } : {}),
    };
    return fakeResponse(
      request.method === "PATCH" ? 200 : row ? 204 : 201,
      request.method === "PATCH"
        ? { value: JSON.parse(value) as unknown, version }
        : "",
      headers,
    );
  }
  return {
    fetch: (url: string, request: FakeRequest): Promise<FakeResponse> => {
      try {
        return Promise.resolve(handle(url, request));
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error("fake request failed"),
        );
      }
    },
    requests,
    register(userId: string, exp = 2000000000) {
      const token = fakeToken(userId, exp);
      tokens.set(token, userId);
      return token;
    },
    collection(
      name: string,
      readScope: FakeCollection["readScope"],
      writeScope: FakeCollection["writeScope"],
    ) {
      const col: FakeCollection = {
        readScope,
        writeScope,
        rows: new Map(),
        versions: new Map(),
      };
      collections.set(name, col);
      return col;
    },
    seed(name: string, key: string, value: unknown, owner = "") {
      const col = collections.get(name)!;
      const previous = col.rows.get(`${owner}:${key}`);
      col.rows.set(`${owner}:${key}`, {
        value: JSON.stringify(value),
        version:
          (previous?.version ?? col.versions.get(`${owner}:${key}`) ?? 0) + 1,
        from: "server",
        at: Math.floor(now() / 1000),
      });
      col.versions.set(
        `${owner}:${key}`,
        col.rows.get(`${owner}:${key}`)!.version,
      );
    },
    setOnline(value: boolean) {
      online = value;
    },
    setRefusal(status?: number) {
      refusal = status;
    },
  };
}
interface SocketEvent {
  data?: unknown;
  code?: number;
  reason?: string;
}
interface FakeParty {
  partyId: string;
  leaderId: string;
  members: { userId: string; online: boolean }[];
  invited: string[];
  max: number;
}
export function createFakeGameGateway() {
  const users = new Map<string, Socket>();
  const tokens = new Map<string, string>();
  const parties = new Map<string, FakeParty>();
  const sent: { from: string; frame: Record<string, unknown> }[] = [];
  let nextId = 0;
  let filter:
    | ((
        from: string,
        to: string,
        frame: Record<string, unknown>,
      ) => Record<string, unknown> | undefined)
    | undefined;
  function partyFor(user: string) {
    return [...parties.values()].find((p) =>
      p.members.some((m) => m.userId === user),
    );
  }
  function roster(party: FakeParty) {
    for (const m of party.members)
      users.get(m.userId)?.receive({ type: "party", ...party });
  }
  class Socket {
    readyState = 0;
    protocol = "bearer";
    readonly userId: string;
    readonly listeners = new Map<string, ((event: never) => void)[]>();
    constructor(_url: string, protocols: string[]) {
      this.userId = tokens.get(protocols[1] ?? "") ?? "";
      queueMicrotask(() => {
        if (this.readyState !== 0) return;
        if (!this.userId) {
          this.serverClose(4003);
          return;
        }
        const old = users.get(this.userId);
        if (old && old !== this) old.serverClose(4000);
        users.set(this.userId, this);
        this.readyState = 1;
        this.dispatch("open");
        this.receive({
          type: "hello",
          userId: this.userId,
          connectionId: this.userId,
          tick: 200,
          zone: "town",
          mapUrl: "https://fake.invalid/map",
          capabilities: { party: true, event: true },
        });
        const p = partyFor(this.userId);
        if (p) {
          p.members.find((m) => m.userId === this.userId)!.online = true;
          roster(p);
        }
      });
    }
    addEventListener(type: string, listener: (event: never) => void) {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    }
    dispatch(type: string, event?: SocketEvent) {
      for (const listener of this.listeners.get(type) ?? [])
        listener(event as never);
    }
    receive(frame: Record<string, unknown>) {
      const copy = JSON.stringify(frame);
      queueMicrotask(() => {
        if (this.readyState === 1) this.dispatch("message", { data: copy });
      });
    }
    serverClose(code = 1001) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (users.get(this.userId) === this) users.delete(this.userId);
      const p = partyFor(this.userId);
      if (p) {
        p.members.find((m) => m.userId === this.userId)!.online = false;
        roster(p);
      }
      queueMicrotask(() =>
        this.dispatch("close", { code, reason: "fake close" }),
      );
    }
    close(code = 1000) {
      this.serverClose(code);
    }
    send(data: string) {
      if (this.readyState !== 1) throw new Error("fake socket closed");
      const f = JSON.parse(data) as Record<string, unknown>;
      sent.push({ from: this.userId, frame: f });
      let p = partyFor(this.userId);
      const error = (code: string) => this.receive({ type: "error", code });
      if (f.type === "party.create") {
        if (p) {
          error("already_in_party");
          return;
        }
        p = {
          partyId: `party-${++nextId}`,
          leaderId: this.userId,
          members: [{ userId: this.userId, online: true }],
          invited: [],
          max: 4,
        };
        parties.set(p.partyId, p);
        roster(p);
      } else if (f.type === "party.invite") {
        if (!p || p.leaderId !== this.userId) {
          error("not_leader");
          return;
        }
        const to = String(f.userId);
        if (!users.has(to)) {
          error("unknown_user");
          return;
        }
        p.invited.push(to);
        users.get(to)!.receive({
          type: "party.invite",
          partyId: p.partyId,
          from: this.userId,
        });
        roster(p);
      } else if (f.type === "party.accept") {
        const invited = parties.get(String(f.partyId));
        if (!invited?.invited.includes(this.userId)) {
          error("not_invited");
          return;
        }
        invited.invited = invited.invited.filter((x) => x !== this.userId);
        invited.members.push({ userId: this.userId, online: true });
        roster(invited);
      } else if (f.type === "party.decline") {
        const invited = parties.get(String(f.partyId));
        if (invited) {
          invited.invited = invited.invited.filter((x) => x !== this.userId);
          users.get(invited.leaderId)?.receive({
            type: "party.declined",
            partyId: invited.partyId,
            userId: this.userId,
          });
          roster(invited);
        }
      } else if (f.type === "party.leave") {
        if (p) {
          p.members = p.members.filter((m) => m.userId !== this.userId);
          if (p.leaderId === this.userId)
            p.leaderId = p.members[0]?.userId ?? "";
          if (!p.members.length) parties.delete(p.partyId);
          else roster(p);
        }
        this.receive({
          type: "party",
          partyId: "",
          members: [],
          leaderId: "",
          invited: [],
          max: 0,
        });
      } else if (f.type === "event") {
        const targets =
          f.scope === "party"
            ? (p?.members.filter((m) => m.online).map((m) => m.userId) ?? [])
            : users.has(String(f.to))
              ? [String(f.to)]
              : [];
        if (!targets.length) {
          error("unknown_user");
          return;
        }
        if (Buffer.byteLength(JSON.stringify(f.payload)) > 8192) {
          error("too_long");
          return;
        }
        const frame = { ...f, from: this.userId };
        for (const to of targets) {
          const output = filter ? filter(this.userId, to, frame) : frame;
          if (output) users.get(to)?.receive(output);
        }
      }
    }
  }
  return {
    WebSocket: Socket,
    sent,
    register(userId: string, token: string) {
      tokens.set(token, userId);
    },
    disconnect(userId: string, code = 1001) {
      users.get(userId)?.serverClose(code);
    },
    inject(userId: string, frame: Record<string, unknown>) {
      users.get(userId)?.receive(frame);
    },
    setFilter(value?: typeof filter) {
      filter = value;
    },
  };
}
