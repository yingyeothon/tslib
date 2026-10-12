import { bytes, copyJson, hashJson } from "./json.js";
import { emitter, kitError, mapError, type Runtime } from "./runtime.js";
import type { RoomControl } from "./room.js";
import type { Save, TurnGame, TurnRecord, TurnsStartOptions } from "./types.js";

const zeroHash = "0".repeat(64);
interface Manifest {
  gameId: string;
  requestId: string;
  count: number;
  finalHash: string;
  chunks: number;
}
function chunks<T>(records: T[], limit: number): T[][] {
  const result: T[][] = [];
  let part: T[] = [];
  for (const record of records) {
    if (bytes([record]) > limit) throw kitError("turns", "payload_too_large");
    if (bytes([...part, record]) > limit) {
      result.push(part);
      part = [];
    }
    part.push(record);
  }
  if (part.length) result.push(part);
  return result;
}
export function createTurnGame<Move, State>(
  runtime: Runtime,
  control: RoomControl,
  save: Save,
  options: TurnsStartOptions<Move, State>,
): TurnGame<Move, State> {
  if (options.room !== control.room)
    throw new TypeError("turns must use this kit's room");
  const maxBytes = options.maxLogBytes ?? 1048576;
  const ttl = options.logTtlSeconds ?? 604800;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    !Number.isSafeInteger(ttl) ||
    ttl <= 0 ||
    ttl > 31622400
  )
    throw new RangeError("invalid turns log limits");
  const players = [
    ...(options.players ?? options.room.members.map((m) => m.userId)),
  ];
  if (
    !players.length ||
    new Set(players).size !== players.length ||
    !players.every((p) => options.room.members.some((m) => m.userId === p))
  )
    throw new TypeError("invalid turn players");
  const generation = runtime.generation;
  let state = copyJson(options.initial);
  let records: TurnRecord<Move>[] = [];
  let frozen = false;
  let disposed = false;
  let finished = false;
  let resultSaved = false;
  let persistenceDirty = false;
  let finishResult: unknown;
  const elapsed: Record<string, number> = Object.fromEntries(
    players.map((p) => [p, 0]),
  );
  let turnStarted = runtime.clock.now();
  let gameId: string | undefined;
  let initialHash = "";
  const events = emitter();
  let lane: Promise<unknown> = Promise.resolve();
  const cleanups: (() => void)[] = [];
  let assembly:
    | {
        manifest: Manifest;
        from: string;
        parts: Map<number, TurnRecord<Move>[]>;
        totalBytes: number;
      }
    | undefined;
  let requestId: string | undefined;
  let requestedFrom: string | undefined;
  let replayRequestId: string | undefined;
  let pendingFinish:
    { result: unknown; count: number; finalHash: string } | undefined;
  let cancelAssembly = () => {};
  let buffered: {
    from: string;
    payload: TurnRecord<Move> & { gameId: string };
  }[] = [];
  function active() {
    return !disposed && !runtime.disposed && generation === runtime.generation;
  }
  function check() {
    if (!active()) throw kitError("turns", "signed_out");
    if (frozen || finished) throw kitError("turns", "invalid_state");
  }
  function fail(index: number, by: string) {
    frozen = true;
    cancelAssembly();
    requestId = undefined;
    assembly = undefined;
    buffered = [];
    events.emit("mismatch", { index, by });
  }
  function enqueue(action: () => Promise<void>) {
    const task = lane
      .catch(() => {})
      .then(async () => {
        if (active()) await action();
      });
    lane = task.catch((error) =>
      events.emit("error", mapError("turns", error)),
    );
  }
  function finalHash() {
    return records.at(-1)?.hash ?? zeroHash;
  }
  function subscribe(
    name: string,
    callback: (from: string, data: unknown) => Promise<void>,
  ) {
    cleanups.push(
      control.on(name, ({ from, payload }) =>
        enqueue(() => callback(from, payload)),
      ),
    );
  }
  async function persist() {
    if (!options.persist || !gameId) return;
    const revision = crypto.randomUUID();
    const parts = chunks(records, 15000);
    const prefix = `turns:${options.room.id}:${gameId}:${revision}`;
    for (let i = 0; i < parts.length; i++) {
      if (!active() || frozen) throw kitError("turns", "invalid_state");
      await save.store(`${prefix}:${i}`, parts[i], { ttl });
    }
    if (!active() || frozen) throw kitError("turns", "invalid_state");
    await save.store(
      `turns:${options.room.id}`,
      {
        v: 1,
        gameId,
        players,
        initialHash,
        revision,
        chunks: parts.length,
        count: records.length,
        finalHash: finalHash(),
      },
      { ttl },
    );
    persistenceDirty = false;
  }
  async function validate(log: TurnRecord<Move>[]): Promise<State> {
    let rebuilt = copyJson(options.initial);
    let previousHash = zeroHash;
    for (let i = 0; i < log.length; i++) {
      const item = log[i]!;
      if (
        item.index !== i ||
        item.by !== players[i % players.length] ||
        item.hash !== (await hashJson([previousHash, i, item.by, item.move]))
      )
        throw kitError("turns", "mismatch");
      rebuilt = copyJson(
        options.apply(copyJson(rebuilt), copyJson(item.move), item.by),
      );
      previousHash = item.hash;
    }
    return rebuilt;
  }
  async function accept(from: string, data: unknown) {
    const item = data as TurnRecord<Move> & { gameId: string };
    if (!item || item.gameId !== gameId || frozen || finished) return;
    if (requestId) {
      buffered.push({ from, payload: copyJson(item) });
      if (bytes(buffered) > maxBytes) fail(records.length, from);
      return;
    }
    if (item.index < records.length) {
      if (records[item.index]?.hash !== item.hash || item.by !== from)
        fail(item.index, from);
      return;
    }
    if (item.index > records.length) {
      await requestLog();
      buffered.push({ from, payload: copyJson(item) });
      return;
    }
    try {
      if (
        item.by !== from ||
        item.by !== players[records.length % players.length] ||
        item.hash !==
          (await hashJson([finalHash(), item.index, item.by, item.move]))
      ) {
        fail(records.length, from);
        return;
      }
    } catch {
      fail(records.length, from);
      return;
    }
    try {
      const next = copyJson(
        options.apply(copyJson(state), copyJson(item.move), item.by),
      );
      const nextRecords = [
        ...records,
        {
          index: item.index,
          move: copyJson(item.move),
          by: item.by,
          hash: item.hash,
        },
      ];
      if (bytes(nextRecords) > maxBytes)
        throw kitError("turns", "payload_too_large");
      elapsed[item.by] =
        (elapsed[item.by] ?? 0) +
        Math.max(0, runtime.clock.now() - turnStarted);
      turnStarted = runtime.clock.now();
      state = next;
      records = nextRecords;
      persistenceDirty = !!options.persist;
      events.emit("turn", {
        state: copyJson(state),
        move: copyJson(item.move),
        by: item.by,
        index: item.index,
      });
    } catch (error) {
      if ((error as { code?: string }).code === "payload_too_large")
        throw error;
      fail(item.index, from);
      return;
    }
    try {
      await persist();
    } catch (error) {
      events.emit("error", mapError("turns", error));
    }
  }
  async function announce(to?: string) {
    if (gameId)
      await control.send(
        "kit.turns.start",
        { gameId, players, initialHash },
        to,
      );
  }
  async function requestLog() {
    if (!active() || requestId) return;
    const target = responderFor(runtime.identity!.userId);
    if (!target) return;
    requestedFrom = target;
    requestId = crypto.randomUUID();
    replayRequestId = requestId;
    assembly = undefined;
    buffered = [];
    const expected = requestId;
    cancelAssembly();
    cancelAssembly = runtime.clock.schedule(() => {
      if (requestId === expected) {
        requestId = undefined;
        assembly = undefined;
        buffered = [];
        events.emit("error", kitError("turns", "unavailable"));
      }
    }, 30000);
    await control.send(
      "kit.turns.log",
      { gameId: gameId ?? "", requestId },
      target,
    );
  }
  function responderFor(requester: string): string | undefined {
    return (
      options.room.members.find(
        (m) =>
          m.userId === options.room.host && m.online && m.userId !== requester,
      )?.userId ??
      players.find(
        (p) =>
          p !== requester &&
          options.room.members.some((m) => m.userId === p && m.online),
      )
    );
  }
  async function replyLog(from: string, data: unknown) {
    const v = data as { gameId?: string; requestId?: string };
    if (
      !gameId ||
      !v ||
      typeof v.requestId !== "string" ||
      (v.gameId && v.gameId !== gameId)
    )
      return;
    const responder = responderFor(from);
    if (responder !== runtime.identity?.userId) return;
    const snapshot = copyJson(records);
    const parts = chunks(snapshot, 7000);
    await announce(from);
    await control.send(
      "kit.turns.manifest",
      {
        gameId,
        requestId: v.requestId,
        count: snapshot.length,
        finalHash: snapshot.at(-1)?.hash ?? zeroHash,
        chunks: parts.length,
      },
      from,
    );
    // Schedule the chunk stream separately; sleeping inside the turn lane
    // would prevent applying live moves while a peer downloads its log.
    runtime.background(
      "turns",
      (async () => {
        for (let i = 0; i < parts.length; i++) {
          if (!active()) return;
          if (i > 0)
            await new Promise<void>((resolve) => {
              const cancel = runtime.clock.schedule(resolve, 200);
              cleanups.push(() => {
                cancel();
                resolve();
              });
            });
          if (!active()) return;
          await control.send(
            "kit.turns.chunk",
            { gameId, requestId: v.requestId, part: i, records: parts[i] },
            from,
          );
        }
        if (finished && active()) {
          await control.send(
            "kit.turns.finish",
            {
              gameId,
              result: finishResult,
              requestId: v.requestId,
              count: records.length,
              finalHash: finalHash(),
            },
            from,
          );
        }
      })(),
    );
  }
  async function commitAssembly() {
    if (!assembly || assembly.parts.size !== assembly.manifest.chunks) return;
    const current = assembly;
    const log: TurnRecord<Move>[] = [];
    for (let i = 0; i < current.manifest.chunks; i++) {
      const part = current.parts.get(i);
      if (!part) return;
      log.push(...part);
    }
    try {
      if (
        log.length !== current.manifest.count ||
        (log.at(-1)?.hash ?? zeroHash) !== current.manifest.finalHash ||
        log.length < records.length ||
        records.some((r, i) => log[i]?.hash !== r.hash)
      )
        throw kitError("turns", "mismatch");
      const rebuilt = await validate(log);
      if (!active()) return;
      records = copyJson(log);
      persistenceDirty = !!options.persist;
      state = rebuilt;
      requestId = undefined;
      assembly = undefined;
      cancelAssembly();
    } catch {
      fail(records.length, current.from);
      return;
    }
    const waiting = buffered;
    buffered = [];
    for (const item of waiting) await accept(item.from, item.payload);
    if (pendingFinish && !frozen) {
      const finish = pendingFinish;
      pendingFinish = undefined;
      if (finish.count !== records.length || finish.finalHash !== finalHash()) {
        fail(records.length, current.from);
        return;
      }
      await finishLocal(finish.result);
    }
    try {
      await persist();
    } catch (error) {
      events.emit("error", mapError("turns", error));
    }
  }
  subscribe("kit.turns.start", async (from, data) => {
    const v = data as {
      gameId?: string;
      players?: string[];
      initialHash?: string;
    };
    if (
      (from !== options.room.host && from !== requestedFrom) ||
      !v ||
      typeof v.gameId !== "string"
    )
      return;
    await initialized;
    if (
      v.initialHash !== initialHash ||
      JSON.stringify(v.players) !== JSON.stringify(players) ||
      (gameId && gameId !== v.gameId)
    ) {
      fail(records.length, from);
      return;
    }
    gameId = v.gameId;
  });
  subscribe("kit.turn", accept);
  subscribe("kit.turns.log", async (from, data) => {
    await initialized;
    await replyLog(from, data);
  });
  subscribe("kit.turns.manifest", async (from, data) => {
    const v = data as Manifest;
    if (!requestId || !v || v.requestId !== requestId || v.gameId !== gameId)
      return;
    const responder = requestedFrom;
    if (
      from !== responder ||
      !Number.isSafeInteger(v.count) ||
      v.count < 0 ||
      !Number.isSafeInteger(v.chunks) ||
      v.chunks < 0 ||
      v.chunks > v.count ||
      (v.count === 0 && v.chunks !== 0) ||
      v.count > Math.floor(maxBytes / 80) ||
      !/^[a-f0-9]{64}$/.test(v.finalHash)
    ) {
      fail(records.length, from);
      return;
    }
    if (assembly && assembly.from !== from) return;
    assembly = { manifest: copyJson(v), from, parts: new Map(), totalBytes: 0 };
    await commitAssembly();
  });
  subscribe("kit.turns.chunk", async (from, data) => {
    const v = data as {
      gameId: string;
      requestId: string;
      part: number;
      records: TurnRecord<Move>[];
    };
    if (
      !assembly ||
      !v ||
      from !== assembly.from ||
      v.gameId !== gameId ||
      v.requestId !== requestId
    )
      return;
    if (
      !Number.isSafeInteger(v.part) ||
      v.part < 0 ||
      v.part >= assembly.manifest.chunks ||
      !Array.isArray(v.records) ||
      !v.records.length
    ) {
      fail(records.length, from);
      return;
    }
    const old = assembly.parts.get(v.part);
    if (old) {
      if (JSON.stringify(old) !== JSON.stringify(v.records))
        fail(records.length, from);
      return;
    }
    assembly.totalBytes += bytes(v.records);
    if (assembly.totalBytes > maxBytes) {
      fail(records.length, from);
      return;
    }
    assembly.parts.set(v.part, copyJson(v.records));
    await commitAssembly();
  });
  async function finishLocal(result: unknown) {
    if (resultSaved) return;
    if (!finished) {
      finishResult = copyJson(result);
      finished = true;
    }
    if (persistenceDirty) await persist();
    if (options.saveResultAs) {
      const payload = {
        gameId,
        result: finishResult,
        players,
        finalHash: finalHash(),
      };
      await save.store(options.saveResultAs, payload);
    }
    resultSaved = true;
  }
  subscribe("kit.turns.finish", async (from, data) => {
    const v = data as {
      gameId: string;
      result: unknown;
      count: number;
      finalHash: string;
      requestId?: string;
    };
    if (
      !v ||
      v.gameId !== gameId ||
      (from !== options.room.host &&
        !(from === requestedFrom && v.requestId === replayRequestId)) ||
      frozen
    )
      return;
    if (
      !Number.isSafeInteger(v.count) ||
      v.count < 0 ||
      !/^[a-f0-9]{64}$/.test(v.finalHash)
    ) {
      fail(records.length, from);
      return;
    }
    if (requestId) {
      pendingFinish = {
        result: copyJson(v.result),
        count: v.count,
        finalHash: v.finalHash,
      };
      return;
    }
    if (v.count > records.length) {
      await requestLog();
      pendingFinish = {
        result: copyJson(v.result),
        count: v.count,
        finalHash: v.finalHash,
      };
      return;
    }
    if (v.count !== records.length || v.finalHash !== finalHash()) {
      fail(records.length, from);
      return;
    }
    await finishLocal(v.result);
  });
  cleanups.push(
    control.on("connected", () => {
      if (gameId) enqueue(requestLog);
    }),
  );
  cleanups.push(
    options.room.on("hostChanged", () => {
      enqueue(async () => {
        if (options.room.isHost) await announce();
        else await requestLog();
      });
    }),
  );
  const initialized = (async () => {
    initialHash = await hashJson(options.initial);
    if (!active()) return;
    if (options.persist) {
      const saved = await save.load<{
        v: number;
        gameId: string;
        players: string[];
        initialHash: string;
        revision: string;
        chunks: number;
        count: number;
        finalHash: string;
      }>(`turns:${options.room.id}`);
      if (
        saved &&
        saved.v === 1 &&
        saved.initialHash === initialHash &&
        JSON.stringify(saved.players) === JSON.stringify(players)
      ) {
        if (
          !Number.isSafeInteger(saved.chunks) ||
          saved.chunks < 0 ||
          !Number.isSafeInteger(saved.count) ||
          saved.count < 0 ||
          saved.chunks > saved.count ||
          saved.count > Math.floor(maxBytes / 80) ||
          (saved.count === 0 && saved.chunks !== 0)
        )
          throw kitError("turns", "mismatch");
        const log: TurnRecord<Move>[] = [];
        const prefix = `turns:${options.room.id}:${saved.gameId}:${saved.revision}`;
        for (let i = 0; i < saved.chunks; i++) {
          const part = await save.load<TurnRecord<Move>[]>(`${prefix}:${i}`);
          if (!part) throw kitError("turns", "unavailable");
          if (!Array.isArray(part) || !part.length)
            throw kitError("turns", "mismatch");
          log.push(...part);
          if (bytes(log) > maxBytes)
            throw kitError("turns", "payload_too_large");
        }
        if (
          log.length !== saved.count ||
          (log.at(-1)?.hash ?? zeroHash) !== saved.finalHash
        )
          throw kitError("turns", "mismatch");
        state = await validate(log);
        records = log;
        gameId = saved.gameId;
      }
    }
    if (options.room.isHost) {
      gameId ??= crypto.randomUUID();
      await announce();
    } else await requestLog();
  })();
  runtime.background(
    "turns",
    initialized.catch((error) => {
      if (mapError("turns", error).code === "mismatch")
        fail(records.length, options.room.host ?? "");
      throw error;
    }),
  );
  const game: TurnGame<Move, State> = {
    get state() {
      return copyJson(state);
    },
    get index() {
      return records.length;
    },
    get log() {
      return copyJson(records);
    },
    get frozen() {
      return frozen;
    },
    get elapsed() {
      const current = players[records.length % players.length]!;
      return {
        ...elapsed,
        ...(!finished && !frozen
          ? {
              [current]:
                (elapsed[current] ?? 0) +
                Math.max(0, runtime.clock.now() - turnStarted),
            }
          : {}),
      };
    },
    submit(move) {
      const task = lane
        .catch(() => {})
        .then(async () => {
          await initialized;
          check();
          if (!gameId || requestId) throw kitError("turns", "invalid_state");
          const by = runtime.identity!.userId;
          if (by !== players[records.length % players.length])
            throw kitError("turns", "not_your_turn");
          const record: TurnRecord<Move> = {
            index: records.length,
            move: copyJson(move),
            by,
            hash: await hashJson([finalHash(), records.length, by, move]),
          };
          chunks([record], 7000);
          if (bytes([...records, record]) > maxBytes)
            throw kitError("turns", "payload_too_large");
          // Reject locally before putting a move no peer can apply on the wire.
          try {
            options.apply(copyJson(state), copyJson(move), by);
          } catch {
            throw kitError("turns", "invalid_state");
          }
          await control.send("kit.turn", { ...record, gameId });
          await accept(by, { ...record, gameId });
        });
      lane = task.catch(() => {});
      return task;
    },
    finish(result) {
      const task = lane
        .catch(() => {})
        .then(async () => {
          await initialized;
          if (!active() || frozen) throw kitError("turns", "invalid_state");
          if (!options.room.isHost) throw kitError("turns", "invalid_state");
          if (
            finished &&
            JSON.stringify(finishResult) !== JSON.stringify(result)
          )
            throw kitError("turns", "invalid_state");
          if (!finished)
            await control.send("kit.turns.finish", {
              gameId,
              result: copyJson(result),
              count: records.length,
              finalHash: finalHash(),
            });
          await finishLocal(result);
        });
      lane = task.catch(() => {});
      return task;
    },
    on(name: string, handler: (event: never) => void) {
      return events.on(name, handler as (event: unknown) => void);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAssembly();
      for (const cancel of cleanups.splice(0)) cancel();
      events.clear();
      buffered = [];
      assembly = undefined;
    },
  };
  cleanups.push(
    runtime.events.on("foreground", () => {
      if (runtime.foreground && persistenceDirty) enqueue(persist);
      if (runtime.foreground && finished && !resultSaved)
        enqueue(() => finishLocal(finishResult));
    }),
  );
  cleanups.push(runtime.events.on("stop", () => game.dispose()));
  cleanups.push(runtime.events.on("change", () => game.dispose()));
  cleanups.push(runtime.events.on("dispose", () => game.dispose()));
  return game;
}
