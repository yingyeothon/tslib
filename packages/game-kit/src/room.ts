import {
  createGatewayLobbyClient,
  type GatewayLobbyClient,
  type PartyFrame,
  type EventBroadcastFrame,
} from "@yingyeothon/gamebase-client";
import { nullLogger } from "@yingyeothon/logger";
import { emitter, kitError, mapError, type Runtime } from "./runtime.js";
import { bytes, copyJson } from "./json.js";
import type { Room, RoomMember, RoomInvitation } from "./types.js";

interface Envelope {
  v: 1;
  roomId: string;
  senderSession: string;
  seq: number;
  data: unknown;
}
export interface RoomControl {
  room: Room;
  send(name: string, payload: unknown, to?: string): Promise<void>;
  on(
    name: string,
    callback: (event: { from: string; payload: unknown }) => void,
  ): () => void;
  connect(): Promise<void>;
}
export function createRoom(runtime: Runtime): RoomControl {
  const events = emitter();
  const control = emitter();
  const gameEvents = emitter();
  const hostEvents = emitter();
  let lobby: GatewayLobbyClient | undefined;
  let roster: PartyFrame | undefined;
  let connectPending: Promise<void> | undefined;
  let lane: Promise<unknown> = Promise.resolve();
  let lastState: unknown;
  let stateRevision = 0;
  let receivedRevision = -1;
  let receivedSession: string | undefined;
  let stateLane: Promise<unknown> = Promise.resolve();
  let interested = false;
  const senderSession = crypto.randomUUID();
  let sequence = 0;
  const seen = new Map<string, number>();
  let pending:
    | {
        check: () => boolean;
        resolve: () => void;
        reject: (error: unknown) => void;
      }
    | undefined;
  const timeout = runtime.options.room?.timeoutMs ?? 10000;
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new RangeError("room timeoutMs must be positive");
  function stop() {
    lobby?.close();
    lobby = undefined;
    connectPending = undefined;
    roster = undefined;
    lastState = undefined;
    seen.clear();
    receivedRevision = -1;
    stateRevision = 0;
    pending?.reject(kitError("room", "signed_out"));
    pending = undefined;
  }
  for (const name of ["stop", "dispose"]) runtime.events.on(name, stop);
  runtime.events.on("change", () => {
    stop();
    if (interested && runtime.identity) runtime.background("room", connect());
  });
  function refused(code: string) {
    const error = kitError(
      "room",
      code === "unknown_user"
        ? "offline"
        : code === "rate_limited"
          ? "rate_limited"
          : code === "too_long"
            ? "payload_too_large"
            : "invalid_state",
    );
    pending?.reject(mapError("room", error));
    events.emit("error", error);
  }
  function applyRoster(frame: PartyFrame) {
    const previous = roster;
    if (previous?.partyId !== frame.partyId) {
      lastState = undefined;
      seen.clear();
      receivedRevision = -1;
    }
    roster = frame;
    const oldMembers = previous?.members ?? [];
    for (const member of frame.members) {
      const old = oldMembers.find((m) => m.userId === member.userId);
      if (!old) events.emit("memberJoined", { ...member });
      else if (old.online !== member.online)
        events.emit("memberOnline", { ...member });
    }
    for (const member of oldMembers)
      if (!frame.members.some((m) => m.userId === member.userId))
        events.emit("memberLeft", { ...member });
    if (previous?.leaderId !== frame.leaderId && frame.leaderId) {
      receivedRevision = -1;
      stateRevision = 0;
      events.emit("hostChanged", frame.leaderId);
      if (room.isHost)
        hostEvents.emit("becomeHost", {
          lastKnown: lastState === undefined ? undefined : copyJson(lastState),
        });
      else runtime.background("room", resync());
    }
    if (pending?.check()) pending.resolve();
    control.emit("roster", frame);
  }
  function applyEvent(frame: EventBroadcastFrame) {
    const v = frame.payload as Partial<Envelope> | null;
    if (
      !v ||
      v.v !== 1 ||
      v.roomId !== room.id ||
      typeof v.senderSession !== "string" ||
      typeof v.seq !== "number" ||
      !Number.isSafeInteger(v.seq) ||
      v.seq < 1 ||
      !room.members.some((m) => m.userId === frame.from)
    )
      return;
    const key = `${frame.from}:${v.senderSession}`;
    if ((seen.get(key) ?? 0) >= v.seq) return;
    seen.set(key, v.seq);
    if (seen.size > 1024) seen.delete(seen.keys().next().value!);
    if (frame.name === "kit.state") {
      const state = v.data as { revision?: number; snapshot?: unknown } | null;
      if (
        frame.from !== room.host ||
        !state ||
        !Number.isSafeInteger(state.revision) ||
        !("snapshot" in state)
      )
        return;
      if (receivedSession !== v.senderSession) {
        receivedRevision = -1;
        receivedSession = v.senderSession;
      }
      if (state.revision! <= receivedRevision) return;
      receivedRevision = state.revision!;
      lastState = copyJson(state.snapshot);
      events.emit("state", copyJson(lastState));
    } else if (frame.name === "kit.resync") {
      if (room.isHost && lastState !== undefined)
        runtime.background(
          "room",
          sendControl(
            "kit.state",
            { revision: stateRevision, snapshot: lastState },
            frame.from,
          ),
        );
    } else if (frame.name.startsWith("kit."))
      control.emit(frame.name, { from: frame.from, payload: v.data });
    else gameEvents.emit(frame.name, { from: frame.from, payload: v.data });
  }
  async function connect() {
    const gateway = runtime.options.config.gateway;
    if (!gateway) throw kitError("room", "not_configured");
    if (!runtime.identity || runtime.disposed)
      throw kitError("room", "signed_out");
    if (lobby?.state === "connected") return;
    if (connectPending) return connectPending;
    if (lobby) {
      await runtime.run("room", async () => {
        await lobby!.connect();
      });
      return;
    }
    const generation = runtime.generation;
    const socket = createGatewayLobbyClient({
      url: gateway.url,
      channelId: gateway.lobbyChannelId,
      token: runtime.identity.token,
      WebSocket: runtime.options.WebSocket,
      logger: nullLogger,
    });
    lobby = socket;
    const current = () =>
      generation === runtime.generation &&
      lobby === socket &&
      !runtime.disposed;
    socket.on("party", (frame) => {
      if (current()) applyRoster(frame);
    });
    socket.on("event", (frame) => {
      if (current()) applyEvent(frame);
    });
    socket.on("partyInvite", (frame) => {
      if (!current()) return;
      const invitation: RoomInvitation = {
        roomId: frame.partyId,
        from: frame.from,
        accept: () =>
          command(
            () => socket.party.accept(frame.partyId),
            () => room.id === frame.partyId,
          ),
        decline: () =>
          command(
            () => socket.party.decline(frame.partyId),
            () => true,
          ),
      };
      events.emit("invited", invitation);
    });
    socket.on("error", (frame) => {
      if (current()) refused(frame.code);
    });
    socket.on("connected", () => {
      if (current()) {
        control.emit("connected");
        if (room.id) runtime.background("room", resync());
      }
    });
    socket.on("disconnected", () => {
      if (current()) pending?.reject(kitError("room", "unavailable"));
    });
    const task = runtime.run("room", async () => {
      await socket.connect();
    });
    connectPending = task;
    try {
      await task;
    } finally {
      if (connectPending === task) connectPending = undefined;
    }
  }
  async function command(action: () => void, check: () => boolean) {
    const generation = runtime.generation;
    const task = lane
      .catch(() => {})
      .then(async () => {
        if (generation !== runtime.generation)
          throw kitError("room", "signed_out");
        await connect();
        await new Promise<void>((resolve, reject) => {
          const cancel = runtime.clock.schedule(() => {
            if (pending === waiter) pending = undefined;
            reject(kitError("room", "unavailable"));
          }, timeout);
          const waiter = {
            check,
            resolve: () => {
              cancel();
              pending = undefined;
              resolve();
            },
            reject: (error: unknown) => {
              cancel();
              pending = undefined;
              reject(mapError("room", error));
            },
          };
          pending = waiter;
          try {
            action();
            if (check()) waiter.resolve();
          } catch (error) {
            waiter.reject(mapError("room", error));
          }
        });
      });
    lane = task.catch(() => {});
    return task;
  }
  async function sendControl(name: string, data: unknown, to?: string) {
    const generation = runtime.generation;
    await connect();
    if (generation !== runtime.generation) throw kitError("room", "signed_out");
    if (!room.id) throw kitError("room", "invalid_state");
    const envelope: Envelope = {
      v: 1,
      roomId: room.id,
      senderSession,
      seq: sequence + 1,
      data: copyJson(data),
    };
    if (bytes(envelope) > 8192) throw kitError("room", "payload_too_large");
    sequence++;
    try {
      lobby!.event({
        scope: to === undefined ? "party" : "user",
        to,
        name,
        payload: envelope,
      });
    } catch (error) {
      throw mapError("room", error);
    }
  }
  async function resync() {
    receivedRevision = -1;
    if (room.host && !room.isHost)
      await sendControl("kit.resync", {}, room.host);
  }
  function validateName(name: string) {
    if (
      !name ||
      name.startsWith("kit.") ||
      new TextEncoder().encode(name).length > 64
    )
      throw new RangeError("invalid game event name");
  }
  const room: Room = {
    get id() {
      return roster?.partyId || undefined;
    },
    get members(): RoomMember[] {
      return roster?.members.map((m) => ({ ...m })) ?? [];
    },
    get host() {
      return roster?.leaderId || undefined;
    },
    get isHost() {
      return room.host !== undefined && room.host === runtime.identity?.userId;
    },
    create() {
      return command(
        () => lobby!.party.create(),
        () => room.id !== undefined && room.isHost,
      );
    },
    invite(userId) {
      if (!userId) return Promise.reject(new TypeError("userId is required"));
      return command(
        () => lobby!.party.invite(userId),
        () =>
          roster?.invited.includes(userId) === true ||
          roster?.members.some((m) => m.userId === userId) === true,
      );
    },
    leave() {
      return command(
        () => lobby!.party.leave(),
        () => room.id === undefined,
      );
    },
    send(name, payload) {
      validateName(name);
      return sendControl(name, payload);
    },
    whisper(userId, name, payload) {
      validateName(name);
      if (!room.members.some((m) => m.userId === userId && m.online))
        return Promise.reject(kitError("room", "offline"));
      return sendControl(name, payload, userId);
    },
    on(name: string, handler: (event: never) => void) {
      interested = true;
      if (runtime.identity) runtime.background("room", connect());
      return (
        new Set([
          "invited",
          "memberJoined",
          "memberLeft",
          "memberOnline",
          "hostChanged",
          "state",
          "error",
        ]).has(name)
          ? events
          : gameEvents
      ).on(name, handler as (event: unknown) => void);
    },
    becomeHost(handler) {
      return hostEvents.on("becomeHost", handler as (event: unknown) => void);
    },
    state: {
      publish(snapshot) {
        const generation = runtime.generation;
        const copy = copyJson(snapshot);
        const task = stateLane
          .catch(() => {})
          .then(async () => {
            if (generation !== runtime.generation)
              throw kitError("room", "signed_out");
            if (!room.isHost) throw kitError("room", "invalid_state");
            const revision = stateRevision + 1;
            await sendControl("kit.state", { revision, snapshot: copy });
            if (generation !== runtime.generation)
              throw kitError("room", "signed_out");
            stateRevision = revision;
            lastState = copy;
          });
        stateLane = task.catch(() => {});
        return task;
      },
    },
  };
  return {
    room,
    send: sendControl,
    on: (name, callback) =>
      control.on(name, callback as (event: unknown) => void),
    connect,
  };
}
