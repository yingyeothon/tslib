import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  GoneException,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  broadcast,
  createGamebaseContext,
  dropConnection,
  fakeConnectionId,
  isGoneException,
  reply,
} from "../src/index.js";

const apiMock = mockClient(ApiGatewayManagementApiClient);
const logger: Logger = { ...nullLogger, severity: "none" };

function newContext() {
  return createGamebaseContext({
    webSocketEndpoint: "http://localhost:3001",
  });
}

function goneException(): GoneException {
  return new GoneException({ $metadata: {}, message: "gone" });
}

beforeEach(() => {
  apiMock.reset();
});

describe("reply", () => {
  it("posts the JSON payload to the connection", async () => {
    apiMock.on(PostToConnectionCommand).resolves({});

    const response = { type: "hello", value: 42 };
    expect(
      await reply("connection-1", response, { context: newContext(), logger }),
    ).toBe(true);

    const calls = apiMock.commandCalls(PostToConnectionCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.ConnectionId).toBe("connection-1");
    expect(JSON.parse(input.Data as string)).toEqual(response);
  });

  it("skips the network for the fake connection id", async () => {
    expect(await reply(fakeConnectionId, { type: "noop" }, { logger })).toBe(
      true,
    );
    expect(apiMock.commandCalls(PostToConnectionCommand)).toHaveLength(0);
  });

  it("returns false when the connection is gone", async () => {
    apiMock.on(PostToConnectionCommand).rejects(goneException());
    expect(
      await reply(
        "gone-1",
        { type: "hello" },
        { context: newContext(), logger },
      ),
    ).toBe(false);
  });

  it("returns false on any other error", async () => {
    apiMock.on(PostToConnectionCommand).rejects(new Error("boom"));
    expect(
      await reply(
        "bad-1",
        { type: "hello" },
        { context: newContext(), logger },
      ),
    ).toBe(false);
  });

  it("uses an injected client", async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as ApiGatewayManagementApiClient;
    expect(
      await reply("connection-1", { type: "hi" }, { client, logger }),
    ).toBe(true);
    expect(send).toHaveBeenCalledOnce();
  });

  it("fails fast without a client or context", async () => {
    await expect(reply("connection-1", { type: "hi" })).rejects.toThrow(
      "reply requires either client or context",
    );
  });
});

describe("dropConnection", () => {
  it("deletes the connection", async () => {
    apiMock.on(DeleteConnectionCommand).resolves({});
    expect(
      await dropConnection("connection-1", { context: newContext() }),
    ).toBe(true);

    const calls = apiMock.commandCalls(DeleteConnectionCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.ConnectionId).toBe("connection-1");
  });

  it("treats an already-gone connection as success", async () => {
    apiMock.on(DeleteConnectionCommand).rejects(goneException());
    expect(await dropConnection("gone-1", { context: newContext() })).toBe(
      true,
    );
  });

  it("returns false on any other error", async () => {
    apiMock.on(DeleteConnectionCommand).rejects(new Error("boom"));
    expect(await dropConnection("bad-1", { context: newContext() })).toBe(
      false,
    );
  });

  it("skips the network for the fake connection id", async () => {
    expect(await dropConnection(fakeConnectionId)).toBe(true);
    expect(apiMock.commandCalls(DeleteConnectionCommand)).toHaveLength(0);
  });
});

describe("broadcast", () => {
  it("reports per-connection delivery results", async () => {
    apiMock
      .on(PostToConnectionCommand)
      .callsFake((input: { ConnectionId: string }) => {
        if (input.ConnectionId === "gone-1") {
          throw goneException();
        }
        return {};
      });

    const result = await broadcast(
      ["connection-1", "gone-1", fakeConnectionId],
      { type: "stage" },
      { context: newContext(), logger },
    );
    expect(result).toEqual({
      "connection-1": true,
      "gone-1": false,
      [fakeConnectionId]: true,
    });
  });

  it("stays silent with the default null logger", async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as ApiGatewayManagementApiClient;
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      expect(
        await broadcast(["connection-1"], { type: "stage" }, { client }),
      ).toEqual({ "connection-1": true });
      expect(info).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });
});

describe("isGoneException", () => {
  it("detects GoneException instances and names", () => {
    expect(isGoneException(goneException())).toBe(true);
    const renamed = new Error("410");
    renamed.name = "GoneException";
    expect(isGoneException(renamed)).toBe(true);
    expect(isGoneException(new Error("other"))).toBe(false);
    expect(isGoneException("gone")).toBe(false);
  });
});

describe("createGamebaseContext management client", () => {
  it("creates the client lazily from options and caches it", async () => {
    const context = createGamebaseContext({
      webSocketEndpoint: "https://example.com/ws",
    });

    const client = context.getApiGatewayManagementClient();
    expect(await client.config.endpoint!()).toMatchObject({
      hostname: "example.com",
    });
    expect(context.getApiGatewayManagementClient()).toBe(client);
  });

  it("prefers the serverless-offline endpoint when isOffline is set", async () => {
    const context = createGamebaseContext({
      isOffline: true,
      webSocketEndpoint: "https://example.com/ws",
    });

    const client = context.getApiGatewayManagementClient();
    expect(await client.config.endpoint!()).toMatchObject({
      hostname: "localhost",
      port: 3001,
    });
  });

  it("uses an injected client", () => {
    const injected = new ApiGatewayManagementApiClient({
      endpoint: "http://localhost:3001",
    });
    const context = createGamebaseContext({
      apiGatewayManagementClient: injected,
    });
    expect(context.getApiGatewayManagementClient()).toBe(injected);
  });
});
