import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import {
  ConnectionState,
  createNaiveSocket,
  createTextMatch,
  withMatch,
  type NaiveSocket,
  type NaiveSocketOptions,
  type TextMatch,
} from "../src/index.js";

const silentLogger: Logger = nullLogger;

interface TestServer {
  server: Server;
  port: number;
  clients: Socket[];
  messages: string[];
  close: () => Promise<void>;
}

function startServer(
  onMessage: (message: string, client: Socket, context: TestServer) => void,
): Promise<TestServer> {
  return new Promise((resolve) => {
    const clients: Socket[] = [];
    const messages: string[] = [];
    const server = createServer((client) => {
      clients.push(client);
      client.on("data", (chunk) => {
        const message = chunk.toString("utf-8");
        messages.push(message);
        onMessage(message, client, context);
      });
      client.on("error", () => undefined);
    });
    const context: TestServer = {
      server,
      port: 0,
      clients,
      messages,
      close: () =>
        new Promise((done) => {
          for (const client of clients) {
            client.destroy();
          }
          server.close(() => done());
        }),
    };
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      context.port = typeof address === "object" && address ? address.port : 0;
      resolve(context);
    });
  });
}

async function findFreePort(): Promise<number> {
  const probe = await startServer(() => undefined);
  const port = probe.port;
  await probe.close();
  return port;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

async function echoServer(): Promise<TestServer> {
  const context = await startServer((message, client) => {
    client.write(message);
  });
  cleanups.push(context.close);
  return context;
}

function newSocket(
  port: number,
  options: Partial<NaiveSocketOptions> = {},
): NaiveSocket {
  const ns = createNaiveSocket({
    host: "127.0.0.1",
    port,
    logger: silentLogger,
    ...options,
  });
  cleanups.push(() => ns.disconnect());
  return ns;
}

describe("NaiveSocket", () => {
  it("sends a request and resolves with the response", async () => {
    const server = await echoServer();
    const ns = newSocket(server.port);
    const response = await ns.send({ message: "HelloWorld" });
    expect(response).toBe("HelloWorld");
    expect(server.messages).toEqual(["HelloWorld"]);
  });

  it("serializes queued sends over one connection", async () => {
    const server = await echoServer();
    const ns = newSocket(server.port);
    const responses = await Promise.all([
      ns.send({ message: "first|", fulfill: "first|".length }),
      ns.send({ message: "second|", fulfill: "second|".length }),
      ns.send({ message: "third|", fulfill: "third|".length }),
    ]);
    expect(responses).toEqual(["first|", "second|", "third|"]);
    expect(server.messages).toEqual(["first|", "second|", "third|"]);
    expect(server.clients).toHaveLength(1);
  });

  it("puts an urgent send at the front of the queue", async () => {
    const server = await echoServer();
    const ns = newSocket(server.port);

    // All three are queued before the connection completes,
    // so the urgent one is written first.
    const first = ns.send({ message: "first|", fulfill: "first|".length });
    const normal = ns.send({ message: "normal|", fulfill: "normal|".length });
    const urgent = ns.send({
      message: "urgent|",
      fulfill: "urgent|".length,
      urgent: true,
    });
    expect(await urgent).toBe("urgent|");
    expect(await first).toBe("first|");
    expect(await normal).toBe("normal|");
    expect(server.messages).toEqual(["urgent|", "first|", "normal|"]);
  });

  it("supports a regex fulfill via its first capture group", async () => {
    const server = await startServer((message, client) => {
      if (message.startsWith("SET")) {
        client.write("+OK\r\n");
      }
    });
    cleanups.push(server.close);
    const ns = newSocket(server.port);
    const response = await ns.send({
      message: "SET key value\r\n",
      fulfill: /^(\+OK\r\n)$/,
    });
    expect(response).toBe("+OK\r\n");
  });

  it("keeps waiting while a regex fulfill does not match yet", async () => {
    const server = await startServer((message, client) => {
      client.write("$36\r\n");
      setTimeout(
        () => client.write("8aede689-bb97-4a3a-8d1e-7f0edf6bd850\r\n"),
        10,
      );
    });
    cleanups.push(server.close);
    const ns = newSocket(server.port);
    const response = await ns.send({
      message: "GET key\r\n",
      fulfill: /^(\$[0-9]+\r\n[0-9A-Za-z-]+\r\n)$/,
    });
    expect(response).toBe("$36\r\n8aede689-bb97-4a3a-8d1e-7f0edf6bd850\r\n");
  });

  it("supports a fixed-length fulfill and keeps the remainder buffered", async () => {
    const server = await startServer((message, client) => {
      if (message === "both") {
        // Reply for the first work plus the beginning of the second one.
        client.write("AAAA" + "BB");
      } else if (message === "more") {
        client.write("CCCC");
      }
    });
    cleanups.push(server.close);
    const ns = newSocket(server.port);
    const first = ns.send({ message: "both", fulfill: 4 });
    const second = ns.send({ message: "more", fulfill: 6 });
    expect(await first).toBe("AAAA");
    expect(await second).toBe("BBCCCC");
  });

  it("supports a custom fulfill function built with withMatch", async () => {
    const payload = "*2\r\n$5\r\nabcde\r\n$6\r\n123456\r\n";
    const server = await startServer((message, client) => {
      if (message.startsWith("SMEMBERS")) {
        client.write(payload);
      }
    });
    cleanups.push(server.close);
    const ns = newSocket(server.port);

    const match = (m: TextMatch) => {
      let count = +(m.capture("\r\n").values()[0] ?? "*0").slice(1);
      while (count-- > 0) {
        m.capture("\r\n").capture("\r\n");
      }
      return m;
    };
    const members = await ns.send({
      message: "SMEMBERS key\r\n",
      fulfill: withMatch(match),
      timeoutMillis: 1000,
    });
    expect(members).toBe(payload);
    expect(match(createTextMatch(members)).values()).toEqual([
      "*2",
      "$5",
      "abcde",
      "$6",
      "123456",
    ]);
  });

  it("rejects with a timeout error when the response never fulfills", async () => {
    const server = await startServer((message, client) => {
      client.write("partial-but-never-matching");
    });
    cleanups.push(server.close);
    const ns = newSocket(server.port);
    await expect(
      ns.send({
        message: "GET key\r\n",
        fulfill: /^(\$[0-9]+\r\n[A-Z]+\r\n)$/,
        timeoutMillis: 50,
      }),
    ).rejects.toThrow(/Timeout/);
  });

  it("drops timed-out works and serves the next request", async () => {
    const port = await findFreePort();
    const ns = newSocket(port, { connectionRetryInterval: 20 });

    // Both are queued while no server exists; the first one times out.
    const first = ns.send({ message: "late|", timeoutMillis: 30 });
    const second = ns.send({
      message: "kept|",
      fulfill: "kept|".length,
      timeoutMillis: 5000,
    });
    await expect(first).rejects.toThrow(/Timeout 30millis/);

    // Start an echo server on the reserved port; the next retry connects.
    const messages: string[] = [];
    const sockets: Socket[] = [];
    const server = createServer((client) => {
      sockets.push(client);
      client.on("data", (chunk) => {
        messages.push(chunk.toString("utf-8"));
        client.write(chunk);
      });
    }).listen(port, "127.0.0.1");
    cleanups.push(
      () =>
        new Promise<void>((done) => {
          for (const socket of sockets) {
            socket.destroy();
          }
          server.close(() => done());
        }),
    );

    expect(await second).toBe("kept|");
    // The timed-out message is never written.
    expect(messages).toEqual(["kept|"]);
  });

  it("reconnects and delivers when the server appears later", async () => {
    const port = await findFreePort();
    const ns = newSocket(port, { connectionRetryInterval: 20 });

    const pending = ns.send({ message: "HelloWorld", timeoutMillis: 2000 });
    // Start the echo server only after the first connect attempts failed.
    setTimeout(() => {
      const sockets: Socket[] = [];
      const server = createServer((client) => {
        sockets.push(client);
        client.on("data", (chunk) => client.write(chunk));
      }).listen(port, "127.0.0.1");
      cleanups.push(
        () =>
          new Promise<void>((done) => {
            for (const socket of sockets) {
              socket.destroy();
            }
            server.close(() => done());
          }),
      );
    }, 100);

    expect(await pending).toBe("HelloWorld");
  });

  it("reconnects after a server-side close and serves later requests", async () => {
    const server = await startServer((message, client) => {
      client.write(message);
    });
    cleanups.push(server.close);
    const ns = newSocket(server.port, { connectionRetryInterval: 20 });

    expect(await ns.send({ message: "one|", fulfill: "one|".length })).toBe(
      "one|",
    );

    // Kill the connection from the server side.
    server.clients[0]!.destroy();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(await ns.send({ message: "two|", fulfill: "two|".length })).toBe(
      "two|",
    );
    expect(server.clients).toHaveLength(2);
  });

  it("rejects pending works with DeadSocket on disconnect", async () => {
    const port = await findFreePort();
    const ns = newSocket(port, { connectionRetryInterval: -1 });
    const promise = ns.send({ message: "SHOULD FAIL", timeoutMillis: 100 });
    ns.disconnect();
    await expect(promise).rejects.toThrow(/DeadSocket/);
  });

  it("does not reconnect when the retry interval is negative", async () => {
    const port = await findFreePort();
    const ns = newSocket(port, { connectionRetryInterval: -1 });
    await expect(
      ns.send({ message: "no-server", timeoutMillis: 60 }),
    ).rejects.toThrow(/Timeout/);
  });

  it("reports connection state changes", async () => {
    const server = await echoServer();
    const states: ConnectionState[] = [];
    const ns = newSocket(server.port, {
      onConnectionStateChanged: ({ socket, state }) => {
        expect(socket).toBe(ns);
        states.push(state);
      },
    });
    await ns.send({ message: "ping" });
    expect(states).toEqual([
      ConnectionState.Connecting,
      ConnectionState.Connected,
    ]);
    ns.disconnect();
    expect(states).toEqual([
      ConnectionState.Connecting,
      ConnectionState.Connected,
      ConnectionState.Disconnected,
    ]);
  });

  it("logs and drops unsolicited data arriving with no pending work", async () => {
    const server = await startServer((message, client) => {
      client.write(message);
      setTimeout(() => client.write("unsolicited"), 10);
    });
    cleanups.push(server.close);
    const errorLog = vi.fn();
    const ns = newSocket(server.port, {
      logger: { ...silentLogger, error: errorLog },
    });
    await ns.send({ message: "ping", fulfill: "ping".length });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(errorLog).toHaveBeenCalledWith(
      "[NaiveSocket]",
      "No work but more response",
      "unsolicited",
    );
    // The stray buffer is cleared so a later request is unaffected.
    expect(await ns.send({ message: "pong", fulfill: "pong".length })).toBe(
      "pong",
    );
  });

  it("waits for more data when a fixed-length fulfill is not satisfied yet", async () => {
    const server = await startServer((message, client) => {
      client.write("AB");
      setTimeout(() => client.write("CD"), 10);
    });
    cleanups.push(server.close);
    const ns = newSocket(server.port);
    expect(await ns.send({ message: "go", fulfill: 4 })).toBe("ABCD");
  });

  it("rejects the active work when the write fails on a broken socket", async () => {
    const server = await echoServer();
    const ns = newSocket(server.port, { connectionRetryInterval: -1 });
    await ns.send({ message: "warmup" });

    // Destroy the underlying socket; its close event has not been handled
    // yet, so the next send still writes to the destroyed socket and the
    // write callback reports the error.
    const internals = ns as unknown as { socket: Socket };
    internals.socket.destroy();
    await expect(
      ns.send({ message: "never-sent", timeoutMillis: 1000 }),
    ).rejects.toThrow(/destroyed/i);
  });

  it("ignores an error event while connected", async () => {
    const server = await echoServer();
    const warn = vi.fn();
    const error = vi.fn();
    const ns = newSocket(server.port, {
      logger: { ...silentLogger, warn, error },
    });
    await ns.send({ message: "ping" });

    const internals = ns as unknown as { onError: (error: Error) => void };
    internals.onError(new Error("caught by the write callback instead"));
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("logs an unexpected error event in the disconnected state", () => {
    const error = vi.fn();
    const ns = newSocket(1, { logger: { ...silentLogger, error } });

    const internals = ns as unknown as { onError: (error: Error) => void };
    const unexpected = new Error("boom");
    internals.onError(unexpected);
    expect(error).toHaveBeenCalledWith(
      "[NaiveSocket]",
      "Invalid error in disconnected state",
      unexpected,
    );
  });

  it("warns when destroying the socket fails during disconnect", async () => {
    const server = await echoServer();
    const warn = vi.fn();
    const ns = newSocket(server.port, { logger: { ...silentLogger, warn } });
    await ns.send({ message: "ping" });

    const internals = ns as unknown as { socket: Socket };
    const realSocket = internals.socket;
    const realDestroy = realSocket.destroy.bind(realSocket);
    const failure = new Error("destroy failed");
    realSocket.destroy = () => {
      throw failure;
    };
    ns.disconnect();
    expect(warn).toHaveBeenCalledWith(
      "[NaiveSocket]",
      "Error occurred while disconnecting",
      failure,
    );
    // Release the handle for real.
    realDestroy();
  });

  it("stays silent by default without touching the console", async () => {
    const server = await echoServer();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const ns = createNaiveSocket({ host: "127.0.0.1", port: server.port });
      cleanups.push(() => ns.disconnect());
      expect(await ns.send({ message: "quiet" })).toBe("quiet");
      expect(info).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
      error.mockRestore();
    }
  });
});
