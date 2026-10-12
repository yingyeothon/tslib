import type {
  WebSocketConstructor,
  WebSocketLike,
} from "@yingyeothon/gamebase-client";
import {
  array,
  bool,
  createHttp,
  credential,
  failure,
  int,
  isPlatformClientError,
  origin,
  protect,
  record,
  segment,
  shape,
  str,
} from "./http.js";
import type {
  DeferredMatchClient,
  DeferredMatchClientOptions,
  LiveMatchClient,
  LiveMatchClientOptions,
  MatchResult,
  MatchTicket,
} from "./types.js";
const resultCheck = shape({
  matchId: (v) => typeof v === "string" && !!v,
  partial: bool,
  result: () => true,
  members: array(shape({ userId: (v) => typeof v === "string" && !!v })),
});
export function ticketCheck(v: unknown): boolean {
  if (!record(v)) return false;
  switch (v.state) {
    case "waiting":
      return shape({ position: int, waited: int })(v);
    case "proposed":
      return shape({
        matchId: str,
        acceptBy: int,
        accepted: bool,
        partial: bool,
      })(v);
    case "confirmed":
      return resultCheck(v);
    case "declined":
      return shape({ matchId: str })(v);
    case "expired":
      return (
        (v.reason === "wait" || v.reason === "accept") &&
        (v.matchId === undefined || typeof v.matchId === "string")
      );
    case "failed":
      return (
        (v.reason === "callback" || v.reason === "closed") &&
        (v.matchId === undefined || typeof v.matchId === "string")
      );
    default:
      return false;
  }
}
export function createDeferredMatchClient(
  options: DeferredMatchClientOptions,
): DeferredMatchClient {
  const http = createHttp(options);
  const path = `/m/${segment(options.channelId)}`;
  return protect<DeferredMatchClient>({
    async submit() {
      return http<MatchTicket>(`${path}/ticket`, "POST", [200], ticketCheck);
    },
    async status() {
      try {
        return await http<MatchTicket>(
          `${path}/ticket`,
          "GET",
          [200],
          ticketCheck,
        );
      } catch (e) {
        if (isPlatformClientError(e) && e.status === 404) return undefined;
        throw e;
      }
    },
    async cancel() {
      await http(`${path}/ticket`, "DELETE", [204], (v) => v === undefined);
    },
    async accept() {
      return http<MatchTicket>(`${path}/accept`, "POST", [200], ticketCheck);
    },
    async decline() {
      return http<MatchTicket>(`${path}/decline`, "POST", [200], ticketCheck);
    },
  });
}
export function createLiveMatchClient(
  options: LiveMatchClientOptions,
): LiveMatchClient {
  const url = new URL(origin(options.url, /^wss?:$/));
  url.searchParams.set("channel", segment(options.channelId));
  credential(options.token);
  const token = options.token;
  const WebSocket =
    options.WebSocket ??
    (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
  if (!WebSocket) throw new Error("No WebSocket; inject the WebSocket option");
  let socket: WebSocketLike | undefined;
  let pending: Promise<MatchResult> | undefined;
  let rejectPending: ((error: unknown) => void) | undefined;
  function cancel() {
    const old = socket;
    socket = undefined;
    pending = undefined;
    rejectPending?.(failure(0, "cancelled"));
    rejectPending = undefined;
    try {
      old?.close();
    } catch {
      /* Already unusable. */
    }
  }
  return {
    find() {
      if (pending) return pending;
      let resolvePending: (v: MatchResult) => void = () => {};
      let reject: (v: unknown) => void = () => {};
      const task = new Promise<MatchResult>((res, rej) => {
        resolvePending = res;
        reject = rej;
      });
      pending = task;
      rejectPending = reject;
      let current: WebSocketLike;
      try {
        current = new WebSocket(url.href, ["bearer", token]);
        socket = current;
      } catch {
        pending = undefined;
        rejectPending = undefined;
        reject(failure(0, "network"));
        return task;
      }
      const finish = (result?: MatchResult, error?: unknown) => {
        if (socket !== current) return;
        socket = undefined;
        pending = undefined;
        rejectPending = undefined;
        if (error) reject(error);
        else resolvePending(result!);
        try {
          current.close();
        } catch {
          /* Outcome already settled. */
        }
      };
      current.addEventListener("message", (event) => {
        if (socket !== current) return;
        let frame: unknown;
        try {
          if (typeof event.data !== "string") throw new Error();
          frame = JSON.parse(event.data) as unknown;
        } catch {
          finish(undefined, failure(0, "malformed_response"));
          return;
        }
        if (!record(frame) || typeof frame.type !== "string") {
          finish(undefined, failure(0, "malformed_response"));
          return;
        }
        if (frame.type === "matched") {
          if (!resultCheck(frame))
            finish(undefined, failure(0, "malformed_response"));
          else finish(frame as unknown as MatchResult);
        } else if (frame.type === "failed")
          finish(
            undefined,
            failure(0, "unavailable", {
              reason: ["timeout", "callback", "closed"].includes(
                frame.reason as string,
              )
                ? (frame.reason as string)
                : undefined,
            }),
          );
        else if (frame.type === "replaced")
          finish(undefined, failure(0, "cancelled"));
      });
      current.addEventListener("close", () =>
        finish(undefined, failure(0, "network")),
      );
      current.addEventListener("error", () =>
        finish(undefined, failure(0, "network")),
      );
      return task;
    },
    cancel,
  };
}
