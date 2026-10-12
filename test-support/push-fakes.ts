/** Structural stand-in for token/send and push-api routes; never claims FCM receipt. */
export interface FakePushRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
}
export function createFakePushServer() {
  const tokens = new Map<string, Map<string, string>>();
  const uploads = new Map<string, { size: number; recipients?: string[] }>();
  const jobs = new Map<string, Record<string, unknown>>();
  const keys = new Map<string, { payload: string; jobId: string }>();
  const calls: { url: string; request: FakePushRequest }[] = [];
  let sequence = 0;
  const response = (status: number, data?: unknown) => ({
    status,
    headers: { get: () => null },
    text: () => Promise.resolve(data === undefined ? "" : JSON.stringify(data)),
  });
  const error = (status: number, reason?: string) =>
    response(status, {
      error: {
        code:
          status === 409
            ? "conflict"
            : status === 404
              ? "not_found"
              : "bad_request",
        message: "refused",
        details: { reason },
      },
    });
  const counts = {
    resolved: 0,
    sent: 0,
    noToken: 0,
    unregistered: 0,
    failed: 0,
    skipped: 0,
    duplicates: 0,
    missingVariables: 0,
    invalid: 0,
  };
  return {
    calls,
    putUpload(uploadId: string, recipients: string[]) {
      const upload = uploads.get(uploadId);
      if (!upload) throw new Error("Unknown fake upload");
      upload.recipients = recipients;
    },
    async fetch(this: void, urlText: string, request: FakePushRequest) {
      await Promise.resolve();
      calls.push({ url: urlText, request });
      const url = new URL(urlText);
      const parts = url.pathname.split("/").filter(Boolean);
      const family = parts[0];
      const channel = parts[1] ?? "";
      const resource = parts[2];
      const id = parts[3];
      const action = parts[4];
      const bearer =
        request.headers.Authorization?.replace(/^Bearer /, "") ?? "";
      const isToken = family === "push" && resource === "token";
      if (isToken ? !bearer.startsWith("player-") : bearer !== "server-key")
        return error(401);
      const body = request.body
        ? (JSON.parse(request.body) as Record<string, unknown>)
        : {};
      const channelTokens = tokens.get(channel) ?? new Map<string, string>();
      tokens.set(channel, channelTokens);
      if (isToken) {
        if (request.method === "PUT") {
          channelTokens.delete(body.token as string);
          channelTokens.set(body.token as string, bearer);
          const own = [...channelTokens].filter(
            ([, owner]) => owner === bearer,
          );
          if (own.length > 5) channelTokens.delete(own[0]![0]);
          return response(204);
        }
        if (request.method === "DELETE") {
          if (channelTokens.get(body.token as string) === bearer)
            channelTokens.delete(body.token as string);
          return response(204);
        }
      }
      if (
        family === "push" &&
        resource === "send" &&
        request.method === "POST"
      ) {
        const results = [...new Set(body.userIds as string[])].map(
          (userId) => ({
            userId,
            status: [...channelTokens.values()].includes(`player-${userId}`)
              ? "sent"
              : "no-token",
          }),
        );
        return response(200, {
          results,
          sent: results.filter((r) => r.status === "sent").length,
          noToken: results.filter((r) => r.status === "no-token").length,
          failed: 0,
        });
      }
      if (family !== "push-api") return error(404);
      // IDs are scoped by channel, just like the actual routes.
      const scoped = (value: string) => `${channel}:${value}`;
      if (resource === "uploads") {
        if (request.method === "POST") {
          const uploadId = `pu_${++sequence}`;
          uploads.set(scoped(uploadId), { size: body.size as number });
          // The helper accepts the minted ID; retain channel isolation in HTTP reads.
          uploads.set(uploadId, uploads.get(scoped(uploadId))!);
          return response(201, {
            uploadId,
            url: `https://objects.test/${uploadId}?signature=fake`,
            method: "PUT",
            headers: {
              "content-type": "text/csv",
              "content-length": String(body.size),
            },
            expiresAt: 1900000900,
            usableUntil: 1900086400,
            maxBytes: 102401024,
          });
        }
        if (request.method === "DELETE" && id) {
          uploads.delete(scoped(id));
          uploads.delete(id);
          return response(204);
        }
        if (request.method === "GET") {
          const entries = [...uploads]
            .filter(([key]) => key.startsWith(`${channel}:`))
            .map(([key, upload]) => ({
              id: key.slice(channel.length + 1),
              size: upload.size,
              createdBy: "apikey",
              createdByLogin: null,
              createdAt: 1900000000,
              usableUntil: 1900086400,
              pending: true,
              inUse: false,
            }));
          return response(200, { uploads: entries, next: null, max: 20 });
        }
      }
      if (
        ((resource === "jobs" && !id) || resource === "broadcast") &&
        request.method === "POST"
      ) {
        const key = scoped(String(body.idempotencyKey).toLowerCase());
        const payload = JSON.stringify(body);
        const held = keys.get(key);
        if (held)
          return held.payload === payload
            ? response(200, {
                job: jobs.get(scoped(held.jobId)),
                created: false,
              })
            : error(409, "idempotency_key_reused");
        const upload = uploads.get(scoped(body.uploadId as string));
        if (resource === "jobs" && !upload?.recipients)
          return error(409, "upload_missing");
        const jobId = `pj_${++sequence}`;
        const job = {
          id: jobId,
          channelId: channel,
          kind: resource === "jobs" ? "campaign" : "broadcast",
          dryRun: body.dryRun ?? false,
          status: "done",
          error: null,
          errorDetails: null,
          cancelRequested: false,
          idempotencyKey: body.idempotencyKey,
          templateId: body.templateId ?? null,
          uploadId: body.uploadId ?? null,
          message: {
            title: body.title ?? "Hello",
            body: body.body ?? "",
            data: body.data ?? {},
          },
          options: {},
          author: "apikey",
          total: upload?.recipients?.length ?? 1,
          processed: upload?.recipients?.length ?? 1,
          counts: { ...counts },
          report: { available: true, expiresAt: 1900604800 },
          createdAt: 1900000000,
          startedAt: 1900000000,
          finishedAt: 1900000001,
        };
        jobs.set(scoped(jobId), job);
        keys.set(key, { payload, jobId });
        return response(202, { job, created: true });
      }
      if (resource === "jobs" && request.method === "GET" && !id) {
        const key = url.searchParams.get("idempotencyKey");
        const held = key ? keys.get(scoped(key.toLowerCase())) : undefined;
        return response(200, {
          jobs: key
            ? held
              ? [jobs.get(scoped(held.jobId))]
              : []
            : [...jobs]
                .filter(([key]) => key.startsWith(`${channel}:`))
                .map(([, j]) => j),
          next: null,
        });
      }
      if (resource === "jobs" && id) {
        const job = jobs.get(scoped(id));
        if (!job) return error(404);
        if (action === "report")
          return response(200, {
            url: `https://objects.test/${id}.csv?signature=fake`,
            expiresAt: 1900000300,
            reportExpiresAt: 1900604800,
          });
        if (!action || action === "cancel") return response(200, { job });
      }
      return error(404);
    },
  };
}
