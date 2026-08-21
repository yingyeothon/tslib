import {
  setupBaseGameContext,
  type BaseGameContext,
  type NetworkOptions,
  type Transport,
} from "@yingyeothon/lambda-gamebase";
import { describe, expect, it, vi } from "vitest";
import {
  broadcastMemberEntered,
  broadcastStage,
  GameStage,
  processEnter,
  processEnterLeave,
  processLeave,
  pruneUndeliveredUsers,
} from "../src/index.js";

interface SentMessage {
  connectionId: string;
  message: { type: string; payload?: unknown };
}

/** Records what the game decided to send, in place of API Gateway. */
function fakeNetwork(failing: string[] = []): {
  network: NetworkOptions;
  sent: SentMessage[];
} {
  const sent: SentMessage[] = [];
  const transport: Transport = {
    send: (connectionId, message) => {
      sent.push({ connectionId, message: message as SentMessage["message"] });
      return Promise.resolve(!failing.includes(connectionId));
    },
    drop: () => Promise.resolve(true),
  };
  return { network: { transport }, sent };
}

function newContext(): BaseGameContext {
  return setupBaseGameContext([
    { memberId: "m1", name: "one", email: "one@yyt.life" },
    { memberId: "m2", name: "two", email: "two@yyt.life" },
    { memberId: "watcher", name: "w", email: "w@yyt.life", observer: true },
  ]);
}

describe("processEnter", () => {
  it("registers a user connection and announces the entrance", async () => {
    const net = fakeNetwork();
    const context = newContext();
    await processEnter({
      context,
      message: { type: "enter", connectionId: "c1", memberId: "m1" },
      network: net.network,
    });

    expect(context.connectedUsers["c1"]).toMatchObject({ memberId: "m1" });
    expect(context.users[0]).toMatchObject({
      connectionId: "c1",
      load: false,
    });
    expect(net.sent).toEqual([
      {
        connectionId: "c1",
        message: { type: "enter", payload: { memberId: "m1" } },
      },
    ]);
  });

  it("hands the entrance to a custom hook instead", async () => {
    const net = fakeNetwork();
    const context = newContext();
    const onMemberEntered = vi.fn().mockResolvedValue(undefined);

    await processEnter({
      context,
      message: { type: "enter", connectionId: "c1", memberId: "m1" },
      network: net.network,
      onMemberEntered,
    });

    expect(onMemberEntered).toHaveBeenCalledWith({
      context,
      connectionId: "c1",
      memberId: "m1",
      network: net.network,
    });
    expect(net.sent).toEqual([]);
  });

  it("rebinds a reconnecting member and reports it again", async () => {
    const net = fakeNetwork();
    const context = newContext();
    const entrances: string[] = [];
    const onMemberEntered = ({ connectionId }: { connectionId: string }) => {
      entrances.push(connectionId);
      return Promise.resolve();
    };

    await processEnter({
      context,
      message: { type: "enter", connectionId: "c1", memberId: "m1" },
      network: net.network,
      onMemberEntered,
    });
    processLeave({ context, message: { connectionId: "c1" } });
    await processEnter({
      context,
      message: { type: "enter", connectionId: "c2", memberId: "m1" },
      network: net.network,
      onMemberEntered,
    });

    // The hook fires on the reconnect too, which is where a snapshot goes.
    expect(entrances).toEqual(["c1", "c2"]);
    expect(Object.keys(context.connectedUsers)).toEqual(["c2"]);
  });

  it("drops the previous connection when a member reconnects", async () => {
    const net = fakeNetwork();
    const context = newContext();
    await processEnter({
      context,
      message: { type: "enter", connectionId: "c1", memberId: "m1" },
      network: net.network,
    });
    // The `leave` for c1 has not arrived yet, which is the normal case
    // for a dropped mobile connection.
    await processEnter({
      context,
      message: { type: "enter", connectionId: "c1b", memberId: "m1" },
      network: net.network,
    });

    // Counting both would tell the wait stage the party is complete.
    expect(Object.keys(context.connectedUsers)).toEqual(["c1b"]);
    expect(context.users[0]).toMatchObject({ connectionId: "c1b" });
  });

  it("attaches an observer silently", async () => {
    const net = fakeNetwork();
    const context = newContext();
    await processEnter({
      context,
      message: { type: "enter", connectionId: "c9", memberId: "watcher" },
      network: net.network,
    });

    expect(context.observers[0]).toMatchObject({ connectionId: "c9" });
    expect(context.connectedUsers).toEqual({});
    expect(net.sent).toEqual([]);
  });

  it("ignores an unknown member", async () => {
    const net = fakeNetwork();
    const context = newContext();
    await processEnter({
      context,
      message: { type: "enter", connectionId: "c1", memberId: "nobody" },
      network: net.network,
    });
    expect(context.connectedUsers).toEqual({});
    expect(net.sent).toEqual([]);
  });
});

describe("processLeave", () => {
  it("unbinds a user but keeps them for reconnection", async () => {
    const net = fakeNetwork();
    const context = newContext();
    await processEnter({
      context,
      message: { type: "enter", connectionId: "c1", memberId: "m1" },
      network: net.network,
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
    const net = fakeNetwork();
    const context = newContext();
    await processEnter({
      context,
      message: { type: "enter", connectionId: "c9", memberId: "watcher" },
      network: net.network,
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
    const net = fakeNetwork();
    const context = newContext();
    await processEnterLeave({
      context,
      message: { type: "enter", connectionId: "c1", memberId: "m1" },
      network: net.network,
    });
    expect(context.connectedUsers["c1"]).toBeDefined();

    await processEnterLeave({
      context,
      message: { type: "leave", connectionId: "c1" },
      network: net.network,
    });
    expect(context.connectedUsers["c1"]).toBeUndefined();
  });

  it("forwards the entrance hook", async () => {
    const net = fakeNetwork();
    const context = newContext();
    const onMemberEntered = vi.fn().mockResolvedValue(undefined);

    await processEnterLeave({
      context,
      message: { type: "enter", connectionId: "c1", memberId: "m1" },
      network: net.network,
      onMemberEntered,
    });

    expect(onMemberEntered).toHaveBeenCalledOnce();
    expect(net.sent).toEqual([]);
  });
});

describe("broadcastStage", () => {
  it("sends the stage payload to all connected users", async () => {
    const net = fakeNetwork();
    const context = newContext();
    await processEnter({
      context,
      message: { type: "enter", connectionId: "c1", memberId: "m1" },
      network: net.network,
    });
    net.sent.length = 0;

    await expect(
      broadcastStage({
        context,
        stage: GameStage.Running,
        age: 7,
        network: net.network,
      }),
    ).resolves.toEqual({ c1: true });
    expect(net.sent).toEqual([
      {
        connectionId: "c1",
        message: {
          type: "stage",
          payload: { stage: GameStage.Running, age: 7 },
        },
      },
    ]);
  });
});

describe("broadcastMemberEntered", () => {
  it("announces to every connected user", async () => {
    const net = fakeNetwork();
    const context = newContext();
    context.users.forEach((user, index) => {
      user.connectionId = `c${index + 1}`;
      context.connectedUsers[user.connectionId] = user;
    });

    await broadcastMemberEntered({
      context,
      connectionId: "c2",
      memberId: "m2",
      network: net.network,
    });

    expect(net.sent.map((s) => s.connectionId)).toEqual(["c1", "c2"]);
  });
});

describe("pruneUndeliveredUsers", () => {
  it("unbinds only the connections a broadcast could not reach", () => {
    const context = newContext();
    context.users.forEach((user, index) => {
      user.connectionId = `c${index + 1}`;
      context.connectedUsers[user.connectionId] = user;
    });

    const undelivered = pruneUndeliveredUsers({
      context,
      delivered: { c1: true, c2: false },
    });

    expect(undelivered).toEqual(["c2"]);
    expect(Object.keys(context.connectedUsers)).toEqual(["c1"]);
    expect(context.users[1]).toMatchObject({ connectionId: "", load: false });
  });

  it("ignores a connection that already left", () => {
    const context = newContext();
    expect(
      pruneUndeliveredUsers({ context, delivered: { ghost: false } }),
    ).toEqual(["ghost"]);
    expect(context.connectedUsers).toEqual({});
  });
});
