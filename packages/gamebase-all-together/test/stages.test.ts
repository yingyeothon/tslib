import { nullLogger, type Logger } from "@yingyeothon/logger";
import {
  setupBaseGameContext,
  type BaseGameRequest,
  type NetworkOptions,
  type Transport,
} from "@yingyeothon/lambda-gamebase";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  doInStageRunning,
  doInStageWait,
  GameStage,
  runGameAllTogether,
  type GameEndReason,
} from "../src/index.js";

const logger: Logger = { ...nullLogger, severity: "none" };
const members = [
  { memberId: "m1", name: "one", email: "one@yyt.life" },
  { memberId: "m2", name: "two", email: "two@yyt.life" },
];

type GameMessage =
  BaseGameRequest | { type: "move"; connectionId: string; x: number };

interface SentMessage {
  connectionId: string;
  message: { type: string; payload?: unknown };
}

interface FakeNetwork {
  network: NetworkOptions;
  sent: SentMessage[];
  dropped: string[];
  failFor: (connectionId: string) => void;
  ofType: (type: string) => SentMessage[];
  stages: () => Array<{ stage: GameStage; age: number }>;
}

/**
 * A transport standing in for API Gateway: it records what the game loop
 * decided to send instead of mocking the whole gamebase module.
 */
function fakeNetwork(): FakeNetwork {
  const sent: SentMessage[] = [];
  const dropped: string[] = [];
  const failing = new Set<string>();
  const transport: Transport = {
    send: (connectionId, message) => {
      sent.push({ connectionId, message: message as SentMessage["message"] });
      return Promise.resolve(!failing.has(connectionId));
    },
    drop: (connectionId) => {
      dropped.push(connectionId);
      return Promise.resolve(true);
    },
  };
  const ofType = (type: string) => sent.filter((s) => s.message.type === type);
  return {
    network: { transport },
    sent,
    dropped,
    failFor: (connectionId) => failing.add(connectionId),
    ofType,
    stages: () =>
      ofType("stage").map(
        (s) => s.message.payload as { stage: GameStage; age: number },
      ),
  };
}

/** Feeds each scripted batch once, then keeps returning empty batches. */
function scriptedPoll<M>(batches: M[][]): () => Promise<M[]> {
  return () => Promise.resolve(batches.shift() ?? []);
}

function connectedContext() {
  const context = setupBaseGameContext(members);
  context.users.forEach((user, index) => {
    user.connectionId = `c${index + 1}`;
    context.connectedUsers[user.connectionId] = user;
  });
  return context;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("doInStageWait", () => {
  it("returns true once every user is connected", async () => {
    const net = fakeNetwork();
    const context = setupBaseGameContext(members);
    const promise = doInStageWait({
      context,
      gameWaitingSeconds: 10,
      pollIntervalMillis: 50,
      pollMessages: scriptedPoll<BaseGameRequest>([
        [{ type: "enter", connectionId: "c1", memberId: "m1" }],
        [],
        [{ type: "enter", connectionId: "c2", memberId: "m2" }],
      ]),
      logger,
      network: net.network,
    });

    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toBe(true);
    expect(Object.keys(context.connectedUsers).sort()).toEqual(["c1", "c2"]);
    expect(net.stages()).toContainEqual({ stage: GameStage.Wait, age: 0 });
    // The default member-entered hook keeps announcing entrances.
    expect(net.ofType("enter").map((s) => s.message.payload)).toEqual([
      // m1 was alone; m2's entrance reached both connections.
      { memberId: "m1" },
      { memberId: "m2" },
      { memberId: "m2" },
    ]);
  });

  it("returns false when the waiting time runs out", async () => {
    const net = fakeNetwork();
    const context = setupBaseGameContext(members);
    const ages: number[] = [];
    const promise = doInStageWait({
      context,
      gameWaitingSeconds: 2,
      pollIntervalMillis: 100,
      pollMessages: scriptedPoll<BaseGameRequest>([]),
      logger,
      network: net.network,
      onStageChanged: ({ age }) => {
        ages.push(age);
        return Promise.resolve();
      },
    });

    await vi.advanceTimersByTimeAsync(2200);
    await expect(promise).resolves.toBe(false);
    expect(ages).toEqual([0, 1]);
    // Nobody connected, so the default broadcast would have had no target.
    expect(net.sent).toEqual([]);
  });

  it("starts with a partial party when minPlayers allows it", async () => {
    const net = fakeNetwork();
    const context = setupBaseGameContext(members);
    const promise = doInStageWait({
      context,
      gameWaitingSeconds: 1,
      pollIntervalMillis: 50,
      minPlayers: 1,
      pollMessages: scriptedPoll<BaseGameRequest>([
        [{ type: "enter", connectionId: "c1", memberId: "m1" }],
      ]),
      logger,
      network: net.network,
    });

    await vi.advanceTimersByTimeAsync(1200);
    // One member never showed up, but the rest may still play.
    await expect(promise).resolves.toBe(true);
  });

  it("still refuses to start below minPlayers", async () => {
    const net = fakeNetwork();
    const context = setupBaseGameContext(members);
    const promise = doInStageWait({
      context,
      gameWaitingSeconds: 1,
      pollIntervalMillis: 50,
      minPlayers: 2,
      pollMessages: scriptedPoll<BaseGameRequest>([
        [{ type: "enter", connectionId: "c1", memberId: "m1" }],
      ]),
      logger,
      network: net.network,
    });

    await vi.advanceTimersByTimeAsync(1200);
    await expect(promise).resolves.toBe(false);
  });

  it("keeps looping when an enter message fails", async () => {
    const errorLog = vi.fn();
    const context = setupBaseGameContext(members);
    const promise = doInStageWait({
      context,
      gameWaitingSeconds: 10,
      pollIntervalMillis: 50,
      pollMessages: scriptedPoll<BaseGameRequest>([
        [
          { type: "enter", connectionId: "c1", memberId: "m1" },
          { type: "enter", connectionId: "c2", memberId: "m2" },
        ],
      ]),
      logger: { ...logger, error: errorLog },
      network: fakeNetwork().network,
      onMemberEntered: () => Promise.reject(new Error("network down")),
    });

    await vi.advanceTimersByTimeAsync(500);
    // Binding happens before the announcement, so a failed announcement
    // does not un-connect the member.
    await expect(promise).resolves.toBe(true);
    expect(errorLog).toHaveBeenCalledTimes(2);
  });

  it("unbinds undelivered connections when asked", async () => {
    const net = fakeNetwork();
    net.failFor("c2");
    const context = setupBaseGameContext(members);
    const promise = doInStageWait({
      context,
      gameWaitingSeconds: 2,
      pollIntervalMillis: 50,
      dropUndeliveredConnections: true,
      pollMessages: scriptedPoll<BaseGameRequest>([
        [
          { type: "enter", connectionId: "c1", memberId: "m1" },
          { type: "enter", connectionId: "c2", memberId: "m2" },
        ],
      ]),
      logger,
      network: net.network,
    });

    await vi.advanceTimersByTimeAsync(2200);
    await promise;
    // c2 never acknowledged a stage broadcast, so it stopped counting.
    expect(Object.keys(context.connectedUsers)).toEqual(["c1"]);
  });
});

describe("doInStageRunning", () => {
  it("dispatches game messages and honors isGameOver", async () => {
    const net = fakeNetwork();
    const context = connectedContext();
    const processed: GameMessage[] = [];
    let gameOver = false;

    const promise = doInStageRunning<GameMessage>({
      context,
      gameRunningSeconds: 60,
      pollIntervalMillis: 50,
      pollMessages: scriptedPoll<GameMessage>([
        [{ type: "move", connectionId: "c1", x: 1 }],
        [{ type: "leave", connectionId: "c2" }],
        [{ type: "move", connectionId: "c1", x: 2 }],
      ]),
      isGameOver: () => gameOver,
      processMessage: ({ message }) => {
        processed.push(message);
        if (processed.length === 2) {
          gameOver = true;
        }
        return Promise.resolve();
      },
      logger,
      network: net.network,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(processed).toEqual([
      { type: "move", connectionId: "c1", x: 1 },
      { type: "move", connectionId: "c1", x: 2 },
    ]);
    expect(context.connectedUsers["c2"]).toBeUndefined();
  });

  it("reports time deltas between processed messages by default", async () => {
    const net = fakeNetwork();
    const context = connectedContext();
    const deltas: number[] = [];

    const promise = doInStageRunning<GameMessage>({
      context,
      gameRunningSeconds: 60,
      pollIntervalMillis: 100,
      pollMessages: scriptedPoll<GameMessage>([
        [{ type: "move", connectionId: "c1", x: 1 }],
        [{ type: "move", connectionId: "c1", x: 2 }],
      ]),
      isGameOver: () => deltas.length >= 2,
      processMessage: () => Promise.resolve(),
      updateTimeDelta: ({ delta }) => {
        deltas.push(delta);
        return Promise.resolve();
      },
      logger,
      network: net.network,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(deltas).toHaveLength(2);
    expect(deltas[1]).toBeCloseTo(0.1);
  });

  it("advances a fixed tick with no messages at all", async () => {
    const net = fakeNetwork();
    const context = connectedContext();
    const deltas: number[] = [];

    const promise = doInStageRunning<GameMessage>({
      context,
      gameRunningSeconds: 60,
      pollIntervalMillis: 1000,
      tick: { mode: "fixed", intervalMillis: 100 },
      // Nobody sends anything: monsters must still act.
      pollMessages: scriptedPoll<GameMessage>([]),
      isGameOver: () => deltas.length >= 10,
      processMessage: () => Promise.resolve(),
      updateTimeDelta: ({ delta }) => {
        deltas.push(delta);
        return Promise.resolve();
      },
      logger,
      network: net.network,
    });

    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(deltas).toHaveLength(10);
    expect(new Set(deltas)).toEqual(new Set([0.1]));
  });

  it("carries leftover time into the next pass instead of dropping it", async () => {
    const net = fakeNetwork();
    const context = connectedContext();
    const stepsPerPass: number[] = [];
    let deltas = 0;
    let polls = 0;

    const promise = doInStageRunning<GameMessage>({
      context,
      gameRunningSeconds: 60,
      pollIntervalMillis: 1000,
      tick: { mode: "fixed", intervalMillis: 100 },
      pollMessages: () => {
        stepsPerPass.push(deltas);
        ++polls;
        if (polls === 1) {
          // 250ms owed: two whole steps, with 50ms that must not vanish.
          vi.setSystemTime(Date.now() + 250);
        } else if (polls === 2) {
          // 50ms more completes the third step only if the 50ms carried.
          vi.setSystemTime(Date.now() + 50);
        }
        return Promise.resolve([]);
      },
      isGameOver: () => polls >= 3,
      processMessage: () => Promise.resolve(),
      updateTimeDelta: () => {
        ++deltas;
        return Promise.resolve();
      },
      logger,
      network: net.network,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    // Pass 1 ran 2 steps; pass 2 ran the third from the carried remainder.
    expect(stepsPerPass.slice(0, 3)).toEqual([0, 2, 3]);
  });

  it("caps catch-up at maxCatchUpSteps", async () => {
    const net = fakeNetwork();
    const context = connectedContext();
    const deltas: number[] = [];
    let polls = 0;

    const promise = doInStageRunning<GameMessage>({
      context,
      gameRunningSeconds: 60,
      pollIntervalMillis: 1000,
      tick: { mode: "fixed", intervalMillis: 100 },
      pollMessages: () => {
        ++polls;
        if (polls === 1) {
          vi.setSystemTime(Date.now() + 500);
        }
        return Promise.resolve([]);
      },
      isGameOver: () => polls >= 2,
      processMessage: () => Promise.resolve(),
      updateTimeDelta: ({ delta }) => {
        deltas.push(delta);
        return Promise.resolve();
      },
      logger,
      network: net.network,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    // 500ms owed at 100ms per step, capped at the default 5 steps.
    expect(deltas).toHaveLength(5);
  });

  it.each([
    ["intervalMillis", { mode: "fixed", intervalMillis: 0 } as const],
    [
      "maxCatchUpSteps",
      { mode: "fixed", intervalMillis: 50, maxCatchUpSteps: 0 } as const,
    ],
  ])("refuses a %s that would stall the loop", async (_name, tick) => {
    const net = fakeNetwork();
    await expect(
      doInStageRunning<GameMessage>({
        context: connectedContext(),
        gameRunningSeconds: 60,
        pollIntervalMillis: 50,
        tick,
        pollMessages: scriptedPoll<GameMessage>([]),
        isGameOver: () => true,
        processMessage: () => Promise.resolve(),
        updateTimeDelta: () => Promise.resolve(),
        logger,
        network: net.network,
      }),
    ).rejects.toThrow(/must be/);
  });

  it("drops the backlog and warns past maxCatchUpSteps", async () => {
    const net = fakeNetwork();
    const warnLog = vi.fn();
    const context = connectedContext();
    const deltas: number[] = [];
    let polls = 0;

    const promise = doInStageRunning<GameMessage>({
      context,
      gameRunningSeconds: 60,
      pollIntervalMillis: 1000,
      tick: { mode: "fixed", intervalMillis: 100, maxCatchUpSteps: 2 },
      pollMessages: () => {
        ++polls;
        if (polls === 1) {
          vi.setSystemTime(Date.now() + 500);
        }
        return Promise.resolve([]);
      },
      isGameOver: () => polls >= 2,
      processMessage: () => Promise.resolve(),
      updateTimeDelta: ({ delta }) => {
        deltas.push(delta);
        return Promise.resolve();
      },
      logger: { ...logger, warn: warnLog },
      network: net.network,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(deltas).toHaveLength(2);
    expect(warnLog).toHaveBeenCalledWith(
      "Game tick overrun",
      expect.objectContaining({ droppedTicks: 3 }),
    );
  });

  it("stops fixed ticks as soon as the game is over", async () => {
    const net = fakeNetwork();
    const context = connectedContext();
    const deltas: number[] = [];
    let polls = 0;

    const promise = doInStageRunning<GameMessage>({
      context,
      gameRunningSeconds: 60,
      pollIntervalMillis: 1000,
      tick: { mode: "fixed", intervalMillis: 100 },
      pollMessages: () => {
        ++polls;
        if (polls === 1) {
          vi.setSystemTime(Date.now() + 500);
        }
        return Promise.resolve([]);
      },
      isGameOver: () => deltas.length >= 2,
      processMessage: () => Promise.resolve(),
      updateTimeDelta: ({ delta }) => {
        deltas.push(delta);
        return Promise.resolve();
      },
      logger,
      network: net.network,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(deltas).toHaveLength(2);
  });

  it("does not call a clean finish an overrun", async () => {
    const net = fakeNetwork();
    const warnLog = vi.fn();
    const context = connectedContext();
    const deltas: number[] = [];
    let polls = 0;

    const promise = doInStageRunning<GameMessage>({
      context,
      gameRunningSeconds: 60,
      pollIntervalMillis: 1000,
      tick: { mode: "fixed", intervalMillis: 100 },
      pollMessages: () => {
        ++polls;
        if (polls === 1) {
          vi.setSystemTime(Date.now() + 500);
        }
        return Promise.resolve([]);
      },
      // The game clears on the second of five owed steps.
      isGameOver: () => deltas.length >= 2,
      processMessage: () => Promise.resolve(),
      updateTimeDelta: ({ delta }) => {
        deltas.push(delta);
        return Promise.resolve();
      },
      logger: { ...logger, warn: warnLog },
      network: net.network,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(deltas).toHaveLength(2);
    // 300ms is still owed, but the game ended — that is not a backlog.
    expect(warnLog).not.toHaveBeenCalled();
  });

  it("sends no snapshot once the game is over", async () => {
    const net = fakeNetwork();
    const context = connectedContext();
    const snapshots: number[] = [];
    let ticks = 0;

    const promise = doInStageRunning<GameMessage>({
      context,
      gameRunningSeconds: 60,
      pollIntervalMillis: 1000,
      tick: { mode: "fixed", intervalMillis: 100 },
      snapshotIntervalMillis: 100,
      onSnapshot: ({ elapsedMillis }) => {
        snapshots.push(elapsedMillis);
        return Promise.resolve();
      },
      pollMessages: scriptedPoll<GameMessage>([]),
      isGameOver: () => ticks >= 1,
      processMessage: () => Promise.resolve(),
      updateTimeDelta: () => {
        ++ticks;
        return Promise.resolve();
      },
      logger,
      network: net.network,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(ticks).toBe(1);
    expect(snapshots).toEqual([]);
  });

  it("sends snapshots on their own schedule", async () => {
    const net = fakeNetwork();
    const context = connectedContext();
    const snapshots: number[] = [];

    const promise = doInStageRunning<GameMessage>({
      context,
      gameRunningSeconds: 60,
      pollIntervalMillis: 1000,
      tick: { mode: "fixed", intervalMillis: 50 },
      snapshotIntervalMillis: 200,
      onSnapshot: ({ elapsedMillis }) => {
        snapshots.push(elapsedMillis);
        return Promise.resolve();
      },
      pollMessages: scriptedPoll<GameMessage>([]),
      isGameOver: () => snapshots.length >= 4,
      processMessage: () => Promise.resolve(),
      logger,
      network: net.network,
    });

    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(snapshots).toHaveLength(4);
    // Roughly one snapshot per interval, never per tick.
    expect(snapshots[0]).toBeGreaterThanOrEqual(200);
    expect(snapshots[3]).toBeLessThanOrEqual(1000);
  });

  it("sends nothing without a snapshot hook", async () => {
    const net = fakeNetwork();
    const context = connectedContext();
    let polls = 0;

    const promise = doInStageRunning<GameMessage>({
      context,
      gameRunningSeconds: 60,
      pollIntervalMillis: 50,
      snapshotIntervalMillis: 50,
      pollMessages: () => {
        ++polls;
        return Promise.resolve([]);
      },
      isGameOver: () => polls >= 5,
      processMessage: () => Promise.resolve(),
      logger,
      network: net.network,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(net.ofType("snapshot")).toEqual([]);
  });

  it("replaces the stage announcement with a custom hook", async () => {
    const net = fakeNetwork();
    const context = connectedContext();
    const announced: Array<{ stage: GameStage; age: number }> = [];
    let polls = 0;

    const promise = doInStageRunning<GameMessage>({
      context,
      gameRunningSeconds: 60,
      pollIntervalMillis: 100,
      pollMessages: () => {
        ++polls;
        return Promise.resolve([]);
      },
      isGameOver: () => polls >= 15,
      processMessage: () => Promise.resolve(),
      onStageChanged: ({ stage, age }) => {
        announced.push({ stage, age });
        return Promise.resolve();
      },
      logger,
      network: net.network,
    });

    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(announced.length).toBeGreaterThan(0);
    // The built-in wire message is gone once the hook takes over.
    expect(net.ofType("stage")).toEqual([]);
  });

  it("logs and continues when handlers fail", async () => {
    const net = fakeNetwork();
    const context = connectedContext();
    const errorLog = vi.fn();
    let polls = 0;

    const promise = doInStageRunning<GameMessage>({
      context,
      gameRunningSeconds: 60,
      pollIntervalMillis: 50,
      pollMessages: () => {
        ++polls;
        return Promise.resolve(
          polls === 1 ? [{ type: "move", connectionId: "c1", x: 1 }] : [],
        );
      },
      isGameOver: () => polls >= 3,
      processMessage: () => Promise.reject(new Error("bad message")),
      updateTimeDelta: () => Promise.reject(new Error("bad delta")),
      logger: { ...logger, error: errorLog },
      network: net.network,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await promise;
    expect(errorLog).toHaveBeenCalledTimes(2);
  });

  it("keeps running when a fixed tick throws", async () => {
    const net = fakeNetwork();
    const errorLog = vi.fn();
    const context = connectedContext();
    let ticks = 0;

    const promise = doInStageRunning<GameMessage>({
      context,
      gameRunningSeconds: 60,
      pollIntervalMillis: 1000,
      tick: { mode: "fixed", intervalMillis: 100 },
      pollMessages: scriptedPoll<GameMessage>([]),
      isGameOver: () => ticks >= 3,
      processMessage: () => Promise.resolve(),
      updateTimeDelta: () => {
        ++ticks;
        return Promise.reject(new Error("simulation failed"));
      },
      logger: { ...logger, error: errorLog },
      network: net.network,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(ticks).toBe(3);
    expect(errorLog).toHaveBeenCalledTimes(3);
  });

  it("stops when the running time runs out", async () => {
    const net = fakeNetwork();
    const context = connectedContext();
    const promise = doInStageRunning<GameMessage>({
      context,
      gameRunningSeconds: 1,
      pollIntervalMillis: 100,
      pollMessages: scriptedPoll<GameMessage>([]),
      isGameOver: () => false,
      processMessage: () => Promise.resolve(),
      logger,
      network: net.network,
    });

    await vi.advanceTimersByTimeAsync(1200);
    await promise;
    expect(net.stages()).toContainEqual({ stage: GameStage.Running, age: 0 });
  });
});

describe("runGameAllTogether", () => {
  function fullRun(
    overrides: Partial<Parameters<typeof runGameAllTogether<GameMessage>>[0]>,
  ) {
    const net = fakeNetwork();
    const promise = runGameAllTogether<GameMessage>({
      gameId: "game-1",
      members,
      pollMessages: scriptedPoll<GameMessage>([]),
      gameWaitingSeconds: 10,
      gameRunningSeconds: 30,
      pollIntervalMillis: 50,
      isGameOver: () => false,
      processMessage: () => Promise.resolve(),
      // The production default pauses before dropping; tests opt in explicitly.
      endDropDelayMillis: 0,
      logger,
      network: net.network,
      ...overrides,
    });
    return { net, promise };
  }

  it("runs wait then running stages and cleans up at the end", async () => {
    const processed: GameMessage[] = [];
    let gameOver = false;
    const { net, promise } = fullRun({
      pollMessages: scriptedPoll<GameMessage>([
        [{ type: "enter", connectionId: "c1", memberId: "m1" }],
        [{ type: "enter", connectionId: "c2", memberId: "m2" }],
        [{ type: "move", connectionId: "c1", x: 1 }],
      ]),
      isGameOver: () => gameOver,
      processMessage: ({ message }) => {
        processed.push(message);
        gameOver = true;
        return Promise.resolve();
      },
    });

    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(processed).toEqual([{ type: "move", connectionId: "c1", x: 1 }]);
    expect(net.stages()).toContainEqual({ stage: GameStage.End, age: 30 });
    expect([...net.dropped].sort()).toEqual(["c1", "c2"]);
  });

  it("waits endDropDelayMillis after the end stage before dropping", async () => {
    let gameOver = false;
    const { net, promise } = fullRun({
      pollMessages: scriptedPoll<GameMessage>([
        [{ type: "enter", connectionId: "c1", memberId: "m1" }],
        [{ type: "enter", connectionId: "c2", memberId: "m2" }],
        [{ type: "move", connectionId: "c1", x: 1 }],
      ]),
      isGameOver: () => gameOver,
      processMessage: () => {
        gameOver = true;
        return Promise.resolve();
      },
      endDropDelayMillis: 5000,
    });

    // Enough for the loop to finish and announce the end, not for the delay.
    await vi.advanceTimersByTimeAsync(1000);
    expect(net.stages()).toContainEqual({ stage: GameStage.End, age: 30 });
    expect(net.dropped).toEqual([]);

    await vi.advanceTimersByTimeAsync(5000);
    await promise;
    expect([...net.dropped].sort()).toEqual(["c1", "c2"]);
  });

  it("skips the running stage when not everyone connects in time", async () => {
    const processMessage = vi.fn();
    const { net, promise } = fullRun({
      pollMessages: scriptedPoll<GameMessage>([
        [{ type: "enter", connectionId: "c1", memberId: "m1" }],
      ]),
      gameWaitingSeconds: 1,
      processMessage,
    });

    await vi.advanceTimersByTimeAsync(1500);
    await promise;

    expect(processMessage).not.toHaveBeenCalled();
    expect(net.stages()).toContainEqual({ stage: GameStage.End, age: 30 });
    expect(net.dropped).toEqual(["c1"]);
  });

  it("still announces the end stage when the game loop fails", async () => {
    const errorLog = vi.fn();
    const announced: Array<{ stage: GameStage; age: number }> = [];
    const { net, promise } = fullRun({
      pollMessages: () => Promise.reject(new Error("redis is down")),
      logger: { ...logger, error: errorLog },
      onStageChanged: ({ stage, age }) => {
        announced.push({ stage, age });
        return Promise.resolve();
      },
    });

    await vi.advanceTimersByTimeAsync(500);
    await promise;

    expect(errorLog).toHaveBeenCalled();
    expect(announced).toContainEqual({ stage: GameStage.End, age: 30 });
    expect(net.dropped).toEqual([]);
  });

  it.each<[string, GameEndReason, Record<string, unknown>]>([
    [
      "cleared",
      "cleared",
      {
        pollMessages: scriptedPoll<GameMessage>([
          [
            { type: "enter", connectionId: "c1", memberId: "m1" },
            { type: "enter", connectionId: "c2", memberId: "m2" },
          ],
        ]),
        isGameOver: () => true,
      },
    ],
    [
      "timeout",
      "timeout",
      {
        pollMessages: scriptedPoll<GameMessage>([
          [
            { type: "enter", connectionId: "c1", memberId: "m1" },
            { type: "enter", connectionId: "c2", memberId: "m2" },
          ],
        ]),
        gameRunningSeconds: 1,
      },
    ],
    ["notEnoughPlayers", "notEnoughPlayers", { gameWaitingSeconds: 1 }],
    [
      "error",
      "error",
      { pollMessages: () => Promise.reject(new Error("redis is down")) },
    ],
  ])("reports %s to onGameEnd", async (_name, expected, overrides) => {
    const reasons: GameEndReason[] = [];
    const { promise } = fullRun({
      ...overrides,
      onGameEnd: ({ reason }) => {
        reasons.push(reason);
        return Promise.resolve();
      },
    });

    await vi.advanceTimersByTimeAsync(3000);
    await promise;
    expect(reasons).toEqual([expected]);
  });

  it("lets the game speak before the end stage and the disconnects", async () => {
    const timeline: string[] = [];
    const net = fakeNetwork();
    const promise = runGameAllTogether<GameMessage>({
      gameId: "game-1",
      members,
      pollMessages: scriptedPoll<GameMessage>([
        [
          { type: "enter", connectionId: "c1", memberId: "m1" },
          { type: "enter", connectionId: "c2", memberId: "m2" },
        ],
      ]),
      gameWaitingSeconds: 10,
      gameRunningSeconds: 30,
      pollIntervalMillis: 50,
      isGameOver: () => true,
      processMessage: () => Promise.resolve(),
      logger,
      network: {
        transport: {
          send: (connectionId, message) => {
            timeline.push(
              `send:${(message as { type: string }).type}:${connectionId}`,
            );
            return Promise.resolve(true);
          },
          drop: (connectionId) => {
            timeline.push(`drop:${connectionId}`);
            return Promise.resolve(true);
          },
        },
      },
      onGameEnd: ({ context, network }) => {
        timeline.push("onGameEnd");
        // Connections are still open, so a result can still be delivered.
        expect(Object.keys(context.connectedUsers)).toHaveLength(2);
        expect(network).toBeDefined();
        return Promise.resolve();
      },
    });

    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    const endIndex = timeline.indexOf("onGameEnd");
    const stageIndex = timeline.findIndex((entry) =>
      entry.startsWith("send:stage:"),
    );
    const dropIndex = timeline.findIndex((entry) => entry.startsWith("drop:"));
    expect(endIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeLessThan(dropIndex);
    expect(stageIndex).toBeLessThan(dropIndex);
    void net;
  });

  it("keeps going when the end hook throws", async () => {
    const errorLog = vi.fn();
    const announced: Array<{ stage: GameStage; age: number }> = [];
    const { promise } = fullRun({
      gameWaitingSeconds: 1,
      logger: { ...logger, error: errorLog },
      onStageChanged: ({ stage, age }) => {
        announced.push({ stage, age });
        return Promise.resolve();
      },
      onGameEnd: () => Promise.reject(new Error("cannot save rewards")),
    });

    await vi.advanceTimersByTimeAsync(1500);
    await promise;

    expect(errorLog).toHaveBeenCalledWith(
      "Cannot report the game result",
      expect.objectContaining({ gameId: "game-1" }),
    );
    expect(announced).toContainEqual({ stage: GameStage.End, age: 30 });
  });

  it("routes entrances through a custom hook for resynchronization", async () => {
    const resynced: string[] = [];
    const { net, promise } = fullRun({
      gameWaitingSeconds: 1,
      pollMessages: scriptedPoll<GameMessage>([
        [{ type: "enter", connectionId: "c1", memberId: "m1" }],
      ]),
      onMemberEntered: ({ memberId }) => {
        resynced.push(memberId);
        return Promise.resolve();
      },
    });

    await vi.advanceTimersByTimeAsync(1500);
    await promise;

    expect(resynced).toEqual(["m1"]);
    // The default entrance announcement is replaced, not added to.
    expect(net.ofType("enter")).toEqual([]);
  });
});
