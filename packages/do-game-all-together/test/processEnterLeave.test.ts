import {
  broadcast as broadcastFn,
  setupBaseGameContext,
  type BaseGameContext,
} from "@yingyeothon/lambda-gamebase";
import type * as Gamebase from "@yingyeothon/lambda-gamebase";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  broadcastStage,
  GameStage,
  processEnter,
  processEnterLeave,
  processLeave,
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

function newContext(): BaseGameContext {
  return setupBaseGameContext([
    { memberId: "m1", name: "one", email: "one@yyt.life" },
    { memberId: "m2", name: "two", email: "two@yyt.life" },
    { memberId: "watcher", name: "w", email: "w@yyt.life", observer: true },
  ]);
}

beforeEach(() => {
  broadcast.mockClear();
});

describe("processEnter", () => {
  it("registers a user connection and broadcasts the entrance", async () => {
    const context = newContext();
    await processEnter({
      context,
      message: { type: "enter", connectionId: "c1", memberId: "m1" },
    });

    expect(context.connectedUsers["c1"]).toMatchObject({ memberId: "m1" });
    expect(context.users[0]).toMatchObject({
      connectionId: "c1",
      load: false,
    });
    expect(broadcast).toHaveBeenCalledWith(["c1"], {
      type: "enter",
      payload: { memberId: "m1" },
    });
  });

  it("attaches an observer silently", async () => {
    const context = newContext();
    await processEnter({
      context,
      message: { type: "enter", connectionId: "c9", memberId: "watcher" },
    });

    expect(context.observers[0]).toMatchObject({ connectionId: "c9" });
    expect(context.connectedUsers).toEqual({});
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("ignores an unknown member", async () => {
    const context = newContext();
    await processEnter({
      context,
      message: { type: "enter", connectionId: "c1", memberId: "nobody" },
    });
    expect(context.connectedUsers).toEqual({});
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe("processLeave", () => {
  it("unbinds a user but keeps them for reconnection", async () => {
    const context = newContext();
    await processEnter({
      context,
      message: { type: "enter", connectionId: "c1", memberId: "m1" },
    });

    processLeave({ context, message: { connectionId: "c1" } });
    expect(context.connectedUsers).toEqual({});
    expect(context.users[0]).toMatchObject({
      memberId: "m1",
      connectionId: "",
      load: false,
    });
  });

  it("unbinds an observer", async () => {
    const context = newContext();
    await processEnter({
      context,
      message: { type: "enter", connectionId: "c9", memberId: "watcher" },
    });

    processLeave({ context, message: { connectionId: "c9" } });
    expect(context.observers[0]).toMatchObject({ connectionId: "" });
  });

  it("ignores an unknown connection", () => {
    const context = newContext();
    processLeave({ context, message: { connectionId: "ghost" } });
    expect(context.connectedUsers).toEqual({});
  });
});

describe("processEnterLeave", () => {
  it("dispatches enter and leave messages", async () => {
    const context = newContext();
    await processEnterLeave({
      context,
      message: { type: "enter", connectionId: "c1", memberId: "m1" },
    });
    expect(context.connectedUsers["c1"]).toBeDefined();

    await processEnterLeave({
      context,
      message: { type: "leave", connectionId: "c1" },
    });
    expect(context.connectedUsers["c1"]).toBeUndefined();
  });
});

describe("broadcastStage", () => {
  it("sends the stage payload to all connected users", async () => {
    const context = newContext();
    await processEnter({
      context,
      message: { type: "enter", connectionId: "c1", memberId: "m1" },
    });
    broadcast.mockClear();

    await broadcastStage({ context, stage: GameStage.Running, age: 7 });
    expect(broadcast).toHaveBeenCalledWith(["c1"], {
      type: "stage",
      payload: { stage: GameStage.Running, age: 7 },
    });
  });
});
