import { nullLogger, type Logger } from "@yingyeothon/logger";
import {
  broadcast as broadcastFn,
  dropConnection as dropConnectionFn,
  setupBaseGameContext,
  type BaseGameRequest,
} from "@yingyeothon/lambda-gamebase";
import type * as Gamebase from "@yingyeothon/lambda-gamebase";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  doInStageRunning,
  doInStageWait,
  GameStage,
  runGameAllTogether,
} from "../src/index.js";

vi.mock("@yingyeothon/lambda-gamebase", async (importOriginal) => {
  const actual = await importOriginal<typeof Gamebase>();
  return {
    ...actual,
    broadcast: vi.fn().mockResolvedValue({}),
    dropConnection: vi.fn().mockResolvedValue(true),
  };
});

const broadcast = broadcastFn as unknown as Mock;
const dropConnection = dropConnectionFn as unknown as Mock;

const logger: Logger = { ...nullLogger, severity: "none" };
const members = [
  { memberId: "m1", name: "one", email: "one@yyt.life" },
  { memberId: "m2", name: "two", email: "two@yyt.life" },
];

type GameMessage =
  BaseGameRequest | { type: "move"; connectionId: string; x: number };

/** Feeds each scripted batch once, then keeps returning empty batches. */
function scriptedPoll<M>(batches: M[][]): () => Promise<M[]> {
  return () => Promise.resolve(batches.shift() ?? []);
}

function stageBroadcasts(): Array<{ stage: GameStage; age: number }> {
  return broadcast.mock.calls
    .filter(([, message]) => (message as { type: string }).type === "stage")
    .map(
      ([, message]) =>
        (message as { payload: { stage: GameStage; age: number } }).payload,
    );
}

beforeEach(() => {
  vi.useFakeTimers();
  broadcast.mockClear().mockResolvedValue({});
  dropConnection.mockClear().mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("doInStageWait", () => {
  it("returns true once every user is connected", async () => {
    const context = setupBaseGameContext(members);
    const promise = doInStageWait({
      context,
      gameWaitingSeconds: 10,
      loopInterval: 50,
      pollMessages: scriptedPoll<BaseGameRequest>([
        [{ type: "enter", connectionId: "c1", memberId: "m1" }],
        [],
        [{ type: "enter", connectionId: "c2", memberId: "m2" }],
      ]),
      logger,
    });

    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toBe(true);
    expect(Object.keys(context.connectedUsers).sort()).toEqual(["c1", "c2"]);
    // The wait stage announced its age at least once (age 0).
    expect(stageBroadcasts()).toContainEqual({ stage: GameStage.Wait, age: 0 });
  });

  it("returns false when the waiting time runs out", async () => {
    const context = setupBaseGameContext(members);
    const promise = doInStageWait({
      context,
      gameWaitingSeconds: 2,
      loopInterval: 100,
      pollMessages: scriptedPoll<BaseGameRequest>([]),
      logger,
    });

    await vi.advanceTimersByTimeAsync(2200);
    await expect(promise).resolves.toBe(false);
    const ages = stageBroadcasts().map((b) => b.age);
    expect(ages).toEqual([0, 1]);
  });

  it("keeps looping when an enter message fails", async () => {
    broadcast.mockRejectedValueOnce(new Error("network down"));
    const errorLog = vi.fn();
    const context = setupBaseGameContext(members);
    const promise = doInStageWait({
      context,
      gameWaitingSeconds: 10,
      loopInterval: 50,
      pollMessages: scriptedPoll<BaseGameRequest>([
        [
          { type: "enter", connectionId: "c1", memberId: "m1" },
          { type: "enter", connectionId: "c2", memberId: "m2" },
        ],
      ]),
      logger: { ...logger, error: errorLog },
    });

    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toBe(true);
    expect(errorLog).toHaveBeenCalledOnce();
  });
});

describe("doInStageRunning", () => {
  function connectedContext() {
    const context = setupBaseGameContext(members);
    context.users.forEach((user, index) => {
      user.connectionId = `c${index + 1}`;
      context.connectedUsers[user.connectionId] = user;
    });
    return context;
  }

  it("dispatches game messages and honors isGameOver", async () => {
    const context = connectedContext();
    const processed: GameMessage[] = [];
    let gameOver = false;

    const promise = doInStageRunning<GameMessage>({
      context,
      gameRunningSeconds: 60,
      loopInterval: 50,
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
    });

    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(processed).toEqual([
      { type: "move", connectionId: "c1", x: 1 },
      { type: "move", connectionId: "c1", x: 2 },
    ]);
    // The leave message went to enter/leave processing instead.
    expect(context.connectedUsers["c2"]).toBeUndefined();
  });

  it("reports time deltas between processed messages", async () => {
    const context = connectedContext();
    const deltas: number[] = [];

    const promise = doInStageRunning<GameMessage>({
      context,
      gameRunningSeconds: 60,
      loopInterval: 100,
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
    });

    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(deltas).toHaveLength(2);
    // The second delta covers one 100ms loop interval.
    expect(deltas[1]).toBeCloseTo(0.1);
  });

  it("stops when the running time runs out", async () => {
    const context = connectedContext();
    const promise = doInStageRunning<GameMessage>({
      context,
      gameRunningSeconds: 1,
      loopInterval: 100,
      pollMessages: scriptedPoll<GameMessage>([]),
      isGameOver: () => false,
      processMessage: () => Promise.resolve(),
      logger,
    });

    await vi.advanceTimersByTimeAsync(1200);
    await promise;
    expect(stageBroadcasts()).toContainEqual({
      stage: GameStage.Running,
      age: 0,
    });
  });

  it("logs and continues when handlers fail", async () => {
    const context = connectedContext();
    const errorLog = vi.fn();
    let polls = 0;

    const promise = doInStageRunning<GameMessage>({
      context,
      gameRunningSeconds: 60,
      loopInterval: 50,
      pollMessages: () => {
        polls++;
        return Promise.resolve(
          polls === 1 ? [{ type: "move", connectionId: "c1", x: 1 }] : [],
        );
      },
      isGameOver: () => polls >= 3,
      processMessage: () => Promise.reject(new Error("bad message")),
      updateTimeDelta: () => Promise.reject(new Error("bad delta")),
      logger: { ...logger, error: errorLog },
    });

    await vi.advanceTimersByTimeAsync(1000);
    await promise;
    expect(errorLog).toHaveBeenCalledTimes(2);
  });
});

describe("runGameAllTogether", () => {
  it("runs wait then running stages and cleans up at the end", async () => {
    const processed: GameMessage[] = [];
    let gameOver = false;

    const promise = runGameAllTogether<GameMessage>({
      gameId: "game-1",
      members,
      pollMessages: scriptedPoll<GameMessage>([
        [{ type: "enter", connectionId: "c1", memberId: "m1" }],
        [{ type: "enter", connectionId: "c2", memberId: "m2" }],
        [{ type: "move", connectionId: "c1", x: 1 }],
      ]),
      gameWaitingSeconds: 10,
      gameRunningSeconds: 30,
      loopInterval: 50,
      isGameOver: () => gameOver,
      processMessage: ({ message }) => {
        processed.push(message);
        gameOver = true;
        return Promise.resolve();
      },
      logger,
    });

    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(processed).toEqual([{ type: "move", connectionId: "c1", x: 1 }]);
    expect(stageBroadcasts()).toContainEqual({ stage: GameStage.End, age: 30 });
    const dropped = dropConnection.mock.calls
      .map((call) => String(call[0]))
      .sort();
    expect(dropped).toEqual(["c1", "c2"]);
  });

  it("skips the running stage when not everyone connects in time", async () => {
    const processMessage = vi.fn();
    const promise = runGameAllTogether<GameMessage>({
      gameId: "game-1",
      members,
      pollMessages: scriptedPoll<GameMessage>([
        [{ type: "enter", connectionId: "c1", memberId: "m1" }],
      ]),
      gameWaitingSeconds: 1,
      gameRunningSeconds: 30,
      loopInterval: 100,
      isGameOver: () => false,
      processMessage,
      logger,
    });

    await vi.advanceTimersByTimeAsync(1500);
    await promise;

    expect(processMessage).not.toHaveBeenCalled();
    expect(stageBroadcasts()).toContainEqual({ stage: GameStage.End, age: 30 });
    expect(dropConnection).toHaveBeenCalledWith("c1", undefined);
  });

  it("still broadcasts the end stage when the game loop fails", async () => {
    const errorLog = vi.fn();
    const promise = runGameAllTogether<GameMessage>({
      gameId: "game-1",
      members,
      pollMessages: () => Promise.reject(new Error("redis is down")),
      gameWaitingSeconds: 10,
      gameRunningSeconds: 30,
      loopInterval: 50,
      isGameOver: () => false,
      processMessage: () => Promise.resolve(),
      logger: { ...logger, error: errorLog },
    });

    await vi.advanceTimersByTimeAsync(500);
    await promise;

    expect(errorLog).toHaveBeenCalled();
    expect(stageBroadcasts()).toContainEqual({ stage: GameStage.End, age: 30 });
    expect(dropConnection).not.toHaveBeenCalled();
  });
});
