import type {
  KvFetchLike,
  KvFetchRequest,
  KvFetchResponse,
} from "@yingyeothon/kvstore-client";

/**
 * A stand-in for the state stack's `/kv/*` routes, small enough to read in one
 * sitting: two collections, the scope rule that matters (`team` refuses the
 * API, `user` puts entries under an owner), versions, `If-Match`, and the two
 * refusals a game meets first. It is not the server; the wire contract of
 * record is `services/state/README.md` in the service repository.
 */
export interface FakeCollection {
  readScope: "team" | "project" | "user";
  writeScope: "team" | "project" | "user";
}

interface Row {
  value: string;
  version: number;
}

export interface FakeKvServer {
  fetch: KvFetchLike;
  /** Seed an entry as the console (`team`) would; bypasses every scope. */
  seed(collection: string, owner: string, key: string, value: unknown): void;
  /** Every request the client made, as `METHOD /path` plus its condition. */
  readonly log: string[];
}

const respond = (
  status: number,
  body = "",
  headers: Record<string, string> = {},
): KvFetchResponse => {
  const lower = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    status,
    headers: { get: (name) => lower.get(name.toLowerCase()) ?? null },
    text: () => Promise.resolve(body),
  };
};

const refuse = (
  status: number,
  code: string,
  details?: Record<string, unknown>,
) =>
  respond(
    status,
    JSON.stringify({
      error: { code, message: code, ...(details ? { details } : {}) },
    }),
  );

export function createFakeKvServer(
  collections: Record<string, FakeCollection>,
  options: { userId: string; token: string },
): FakeKvServer {
  const rows = new Map<string, Row>(); // `${col} ${owner} ${key}`
  const slot = (col: string, owner: string, key: string) =>
    `${col} ${owner} ${key}`;
  const log: string[] = [];

  function handle(url: string, init: KvFetchRequest): KvFetchResponse {
    const { pathname, searchParams } = new URL(url);
    const condition = init.headers["if-match"] ?? init.headers["if-none-match"];
    log.push(`${init.method} ${pathname}${condition ? ` (${condition})` : ""}`);
    if (init.headers.authorization !== `Bearer ${options.token}`) {
      return refuse(401, "unauthorized");
    }
    // /kv/{col}[/u/{owner}]/entries[/{key}]  or  /kv/{col}
    const m =
      /^\/kv\/([^/]+)(?:\/u\/([^/]+))?(?:\/entries(?:\/([^/]+))?)?$/.exec(
        pathname,
      );
    if (!m) return refuse(404, "not_found");
    const [, colName, rawOwner, key] = m;
    const col = collections[colName!];
    if (!col) return refuse(404, "not_found");
    if (col.readScope === "team" && col.writeScope === "team") {
      return refuse(403, "forbidden");
    }
    if (
      rawOwner === undefined &&
      key === undefined &&
      !pathname.endsWith("/entries")
    ) {
      return respond(
        200,
        JSON.stringify({
          ...col,
          encrypted: false,
          maxEntries: 10000,
          maxEntriesPerOwner: 100,
        }),
      );
    }
    // A player is `me`; the alias resolves to the JWT's own subject.
    const owner = rawOwner === "me" ? options.userId : rawOwner;
    const userNamespace = col.writeScope === "user";
    if (userNamespace !== (owner !== undefined)) {
      return refuse(400, "bad_request", { reason: "wrong_namespace" });
    }
    if (
      owner !== undefined &&
      owner !== options.userId &&
      col.readScope === "user"
    ) {
      return refuse(403, "forbidden");
    }
    const ns = owner ?? "";

    if (key === undefined) {
      const prefix = `${colName} ${ns} `;
      const wantValues = searchParams.get("values") === "1";
      const entries = [...rows.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, row]) => ({
          key: k.slice(prefix.length),
          version: row.version,
          bytes: row.value.length,
          updatedAt: 1_700_000_000,
          ...(wantValues ? { valueText: row.value } : {}),
        }))
        .sort((a, b) => (a.key < b.key ? -1 : 1));
      if (searchParams.get("order") === "desc") entries.reverse();
      return respond(200, JSON.stringify({ entries }));
    }

    const id = slot(colName!, ns, key);
    const row = rows.get(id);
    switch (init.method) {
      case "GET": {
        if (col.readScope === "team") return refuse(403, "forbidden");
        if (!row) return refuse(404, "not_found");
        return respond(200, row.value, { etag: `"${row.version}"` });
      }
      case "PUT": {
        if (col.writeScope === "team") return refuse(403, "forbidden");
        const ifMatch = init.headers["if-match"];
        if (ifMatch !== undefined && (!row || `"${row.version}"` !== ifMatch)) {
          return refuse(409, "conflict", {
            current: row ? row.version : null,
          });
        }
        if (init.headers["if-none-match"] === "*" && row) {
          return refuse(409, "conflict", { current: row.version });
        }
        const version = (row?.version ?? 0) + 1;
        rows.set(id, { value: init.body ?? "", version });
        return respond(row ? 204 : 201, "", { etag: `"${version}"` });
      }
      case "DELETE": {
        if (col.writeScope === "team") return refuse(403, "forbidden");
        rows.delete(id);
        return respond(204);
      }
      default:
        return refuse(405, "method_not_allowed");
    }
  }

  return {
    fetch: (url, init) => Promise.resolve(handle(url, init)),
    seed(collection, owner, key, value) {
      const id = slot(collection, owner, key);
      rows.set(id, {
        value: JSON.stringify(value),
        version: (rows.get(id)?.version ?? 0) + 1,
      });
    },
    log,
  };
}
