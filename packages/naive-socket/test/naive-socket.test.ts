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

  it("does not let an urgent send displace a request already on the wire", async () => {
    // `onData` resolves the head, so an urgent request unshifted in front of
    // a written one is handed that one's reply — and its own message never
    // leaves. The lock heartbeat sends `urgent` from a timer, so this is how
    // a lease gets confirmed by an unrelated command's answer.
    const server = await startServer((message, client) => {
      const slow = message.startsWith("slow");
      setTimeout(
        () => client.write(slow ? "slow-ok|" : "urgent-ok|"),
        slow ? 120 : 5,
      );
    });
    cleanups.push(server.close);
    const ns = newSocket(server.port);

    const slow = ns.send({
      message: "slow|",
      fulfill: "slow-ok|".length,
      timeoutMillis: 2000,
    });
    // Wait for the request to actually reach the server rather than sleeping
    // a guessed interval: a sleep that landed after the reply would make the
    // test pass while no longer testing the race at all.
    while (server.messages.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const urgent = ns.send({
      message: "urgent|",
      fulfill: "urgent-ok|".length,
      urgent: true,
      timeoutMillis: 2000,
    });

    expect(await slow).toBe("slow-ok|");
    expect(await urgent).toBe("urgent-ok|");
    expect(server.messages).toEqual(["slow|", "urgent|"]);
  });

  it("still puts an urgent send in front of everything unwritten", async () => {
    // The queue-time case must keep working: that is the edge `AUTH` uses.
    const server = await echoServer();
    const ns = newSocket(server.port);
    const first = ns.send({ message: "first|", fulfill: "first|".length });
    const urgent = ns.send({
      message: "urgent|",
      fulfill: "urgent|".length,
      urgent: true,
    });
    expect(await urgent).toBe("urgent|");
    expect(await first).toBe("first|");
    expect(server.messages).toEqual(["urgent|", "first|"]);
  });

  it("does not spend a request's budget on the handshake ahead of it", async () => {
    // The shape of a Redis reconnect: a user command is queued first, and
    // the automatic `AUTH` is put in front of it the moment the socket
    // connects. Here the handshake takes 100ms and the command itself is
    // answered 100ms after it reaches the wire — 200ms in total, against a
    // 150ms budget that only ever meant "how long may the server take to
    // answer *this* command".
    const server = await startServer((message, client) => {
      const reply = message.startsWith("handshake")
        ? "handshake-ok|"
        : "command-ok|";
      setTimeout(() => client.write(reply), 100);
    });
    cleanups.push(server.close);
    const ns = newSocket(server.port);

    const command = ns.send({
      message: "command|",
      fulfill: "command-ok|".length,
      timeoutMillis: 150,
    });
    const handshake = ns.send({
      message: "handshake|",
      fulfill: "handshake-ok|".length,
      urgent: true,
      timeoutMillis: 5000,
    });
    expect(await handshake).toBe("handshake-ok|");
    expect(await command).toBe("command-ok|");
    // One connection, handshake first: the command really did wait behind it.
    expect(server.messages).toEqual(["handshake|", "command|"]);
    expect(server.clients).toHaveLength(1);
  });

  it("still rejects a request whose turn never comes in time", async () => {
    // The restart is not a reprieve. The queue-time timer bounds the wait
    // before the write on a perfectly healthy socket too, so a request
    // behind a pipeline slower than its own budget is rejected unwritten —
    // budget for the queue ahead, not only for the round trip.
    const server = await startServer((_message, client) => {
      setTimeout(() => client.write("ok|"), 100);
    });
    cleanups.push(server.close);
    const ns = newSocket(server.port);

    const results = await Promise.allSettled(
      [0, 1, 2].map(() =>
        ns.send({ message: "q|", fulfill: "ok|".length, timeoutMillis: 150 }),
      ),
    );
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "rejected",
    ]);
    // Two answered, and the third never left the process.
    expect(server.messages).toEqual(["q|", "q|"]);
  });

  it("does not restart the budget again on every reconnect", async () => {
    // A peer that swallows the request and drops the connection, forever.
    // The work is rewritten on each reconnect; re-arming its timer there
    // would let it outlive every deadline instead of rejecting.
    const server = await startServer((_message, client) => {
      client.destroy();
    });
    cleanups.push(server.close);
    const ns = newSocket(server.port, { connectionRetryInterval: 10 });

    await expect(
      ns.send({ message: "swallowed|", timeoutMillis: 80 }),
    ).rejects.toThrow(/Timeout 80millis/);
    expect(server.clients.length).toBeGreaterThan(1);
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

  it("reset reconnects on its own for a push consumer", async () => {
    // A subscriber has no pending request to drive the next connect, so a
    // socket it resets has to come back by itself — that is the whole
    // difference from `disconnect`.
    const server = await startServer((message, client) =>
      client.write(message),
    );
    cleanups.push(server.close);
    const ns = newSocket(server.port, {
      connectionRetryInterval: 20,
      onUnsolicitedData: (buffer) => buffer.length,
    });
    expect(await ns.send({ message: "first|", fulfill: "first|".length })).toBe(
      "first|",
    );

    ns.reset(new Error("Invalid password"));
    await vi.waitFor(() => expect(server.clients).toHaveLength(2), {
      timeout: 2000,
      interval: 10,
    });
    // The fresh connection works, and it really is a different socket.
    expect(await ns.send({ message: "again|", fulfill: "again|".length })).toBe(
      "again|",
    );
  });

  it("reset rejects the pending works with its reason", async () => {
    // They belonged to the connection being thrown away; carrying them onto
    // the next one would replay writes the caller is about to reconstruct.
    const server = await startServer(() => undefined);
    cleanups.push(server.close);
    const ns = newSocket(server.port, { connectionRetryInterval: 20 });
    const pending = ns.send({
      message: "never-answered|",
      timeoutMillis: 5000,
    });

    await vi.waitFor(() => expect(server.messages).toHaveLength(1), {
      timeout: 2000,
      interval: 10,
    });
    ns.reset(new Error("Invalid password"));
    await expect(pending).rejects.toThrow("Invalid password");
  });

  it("reset keeps the socket usable for the next send", async () => {
    // With no push consumer and an empty queue there is nothing to reconnect
    // for, so the next `send` is what opens the connection — unlike
    // `disconnect`, which is a shutdown.
    const server = await echoServer();
    const ns = newSocket(server.port, { connectionRetryInterval: 20 });
    expect(await ns.send({ message: "first|", fulfill: "first|".length })).toBe(
      "first|",
    );
    ns.reset();
    expect(await ns.send({ message: "again|", fulfill: "again|".length })).toBe(
      "again|",
    );
    expect(server.clients).toHaveLength(2);
  });

  it("does not let a retry scheduled by a peer close survive disconnect", async () => {
    // `retryToConnect` decides whether to schedule from the queue length at
    // *schedule* time, so an ordinary request/response socket with work in
    // flight when the peer closed had a retry pending too. It only checked
    // the connection state when it fired, so `disconnect()` left a live
    // socket and a live handle behind.
    const server = await startServer((message, client) => {
      // Take the request, answer nothing, and drop the connection.
      setTimeout(() => client.destroy(), 10);
    });
    cleanups.push(server.close);
    const ns = newSocket(server.port, { connectionRetryInterval: 60 });
    const pending = ns.send({ message: "in-flight|", timeoutMillis: 5000 });
    pending.catch(() => undefined);

    await vi.waitFor(() => expect(server.clients).toHaveLength(1), {
      timeout: 2000,
      interval: 10,
    });
    // The peer's close schedules the retry; the shutdown lands before it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    ns.disconnect();
    await expect(pending).rejects.toThrow(/DeadSocket/);

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(server.clients).toHaveLength(1);
  });

  it("does not let a pending retry revive a disconnected push consumer", async () => {
    // The same guard, on the socket that cannot get away with lacking it: a
    // push consumer reconnects on an empty queue by design, so a retry that
    // outlived `disconnect()` reopens a connection nothing can close.
    const server = await startServer(() => undefined);
    cleanups.push(server.close);
    const ns = newSocket(server.port, {
      connectionRetryInterval: 60,
      onUnsolicitedData: (buffer) => buffer.length,
    });
    await ns.send({ message: "hello|", expectResponse: false });
    await vi.waitFor(() => expect(server.clients).toHaveLength(1), {
      timeout: 2000,
      interval: 10,
    });

    ns.reset();
    ns.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(server.clients).toHaveLength(1);
  });

  it("rejects pending works with DeadSocket on disconnect", async () => {
    const port = await findFreePort();
    const ns = newSocket(port, { connectionRetryInterval: -1 });
    const promise = ns.send({ message: "SHOULD FAIL", timeoutMillis: 100 });
    ns.disconnect();
    await expect(promise).rejects.toThrow(/DeadSocket/);
  });

  it("rejects pending works with the given reason on disconnect", async () => {
    const port = await findFreePort();
    const ns = newSocket(port, { connectionRetryInterval: -1 });
    const promise = ns.send({ message: "SHOULD FAIL", timeoutMillis: 100 });
    ns.disconnect(new Error("Invalid password"));
    await expect(promise).rejects.toThrow(/Invalid password/);
  });

  it("serves a send issued right after disconnect on a fresh connection", async () => {
    const server = await startServer((message, client) => {
      client.write(`echo:${message}`);
    });
    cleanups.push(() => server.close());
    const ns = newSocket(server.port, { connectionRetryInterval: 5000 });
    await expect(
      ns.send({
        message: "first",
        fulfill: /(echo:first)/,
        timeoutMillis: 1000,
      }),
    ).resolves.toBe("echo:first");
    ns.disconnect();
    // The old socket's `close` fires after this `send` opened a new one; a
    // retry loop triggered by that event would kill the new socket and
    // leave this request waiting for the retry interval.
    await expect(
      ns.send({
        message: "second",
        fulfill: /(echo:second)/,
        timeoutMillis: 1000,
      }),
    ).resolves.toBe("echo:second");
    expect(server.clients).toHaveLength(2);
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
    // The buffer is whatever the peer sent — a stored value, a credential
    // echo — so only its size may be reported.
    expect(errorLog).toHaveBeenCalledWith(
      "[NaiveSocket]",
      "No work but more response",
      { length: "unsolicited".length },
    );
    expect(
      errorLog.mock.calls.some((call) =>
        call.some((arg) => String(arg).includes("unsolicited")),
      ),
    ).toBe(false);
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

  it("reconnects and resends when the socket was destroyed before the next send", async () => {
    const server = await echoServer();
    const ns = newSocket(server.port, { connectionRetryInterval: -1 });
    await ns.send({ message: "warmup" });

    // Destroy the underlying socket; its close event has not been handled
    // yet, so the state still says Connected when the next send arrives.
    const internals = ns as unknown as { socket: Socket };
    internals.socket.destroy();
    expect(await ns.send({ message: "again", timeoutMillis: 1000 })).toBe(
      "again",
    );
    expect(server.clients).toHaveLength(2);
  });

  it("reconnects and resends when the peer ended the socket before the next send", async () => {
    // A frozen Lambda container resumes with the peer's FIN already on the
    // socket but not yet dispatched: the handler's first send would hit
    // writeAfterFIN (EPIPE). Half-closing from our side puts the socket in
    // the same ended-but-Connected state deterministically.
    const server = await echoServer();
    const ns = newSocket(server.port, { connectionRetryInterval: -1 });
    await ns.send({ message: "warmup" });

    const internals = ns as unknown as { socket: Socket };
    internals.socket.end();
    expect(internals.socket.writableEnded).toBe(true);
    expect(await ns.send({ message: "again", timeoutMillis: 1000 })).toBe(
      "again",
    );
    expect(server.clients).toHaveLength(2);
    expect(server.messages).toEqual(["warmup", "again"]);
  });

  it("reconnects and resends once when the write itself reports a dead peer", async () => {
    // The ended flags are still false when the container resumes before the
    // poll phase; the kernel then answers the write with EPIPE/ECONNRESET.
    const server = await echoServer();
    const ns = newSocket(server.port, { connectionRetryInterval: -1 });
    await ns.send({ message: "warmup" });

    const internals = ns as unknown as { socket: Socket };
    let failures = 0;
    internals.socket.write = ((_chunk: unknown, cb?: (e?: Error) => void) => {
      failures++;
      const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      cb?.(error);
      return false;
    }) as Socket["write"];
    expect(await ns.send({ message: "again", timeoutMillis: 1000 })).toBe(
      "again",
    );
    expect(failures).toBe(1);
    expect(server.clients).toHaveLength(2);
  });

  it("rejects when the resend fails again", async () => {
    const server = await echoServer();
    const poison = (socket: Socket) => {
      socket.write = ((_chunk: unknown, cb?: (e?: Error) => void) => {
        cb?.(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        return false;
      }) as Socket["write"];
    };
    let connections = 0;
    const ns = newSocket(server.port, {
      connectionRetryInterval: -1,
      onConnectionStateChanged: ({ socket, state }) => {
        // Poison every connection after the first, so the resend fails too.
        if (state === ConnectionState.Connected && ++connections > 1) {
          poison((socket as unknown as { socket: Socket }).socket);
        }
      },
    });
    await ns.send({ message: "warmup" });
    const internals = ns as unknown as { socket: Socket };
    poison(internals.socket);
    await expect(
      ns.send({ message: "again", timeoutMillis: 1000 }),
    ).rejects.toThrow(/EPIPE/);
    expect(connections).toBe(2);
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

describe("NaiveSocket unsolicited data", () => {
  /** Consumes one `|`-terminated frame, recording it without the mark. */
  function pipeFrameConsumer(received: string[]): (buffer: string) => number {
    return (buffer) => {
      const index = buffer.indexOf("|");
      if (index < 0) {
        return -1;
      }
      received.push(buffer.slice(0, index));
      return index + 1;
    };
  }

  it("hands data with no pending request to the consumer", async () => {
    const received: string[] = [];
    const server = await startServer((message, client) => {
      if (message === "SUB|") {
        client.write("push-one|push-two|");
      }
    });
    cleanups.push(server.close);
    const ns = newSocket(server.port, {
      onUnsolicitedData: pipeFrameConsumer(received),
    });

    await expect(
      ns.send({ message: "SUB|", expectResponse: false }),
    ).resolves.toBe("");
    await vi.waitFor(() => expect(received).toEqual(["push-one", "push-two"]));
  });

  it("waits for more data while the consumer takes nothing", async () => {
    const received: string[] = [];
    const server = await startServer((message, client) => {
      if (message === "SUB|") {
        client.write("part");
        setTimeout(() => client.write("ial|"), 20);
      }
    });
    cleanups.push(server.close);
    const ns = newSocket(server.port, {
      onUnsolicitedData: pipeFrameConsumer(received),
    });

    await ns.send({ message: "SUB|", expectResponse: false });
    await vi.waitFor(() => expect(received).toEqual(["partial"]));
  });

  it("decodes a multi-byte character split across two chunks", async () => {
    const text = "안녕하세요";
    const encoded = Buffer.from(`${text}|`, "utf-8");
    // Byte 4 falls inside the second syllable, so a per-chunk toString()
    // would corrupt it.
    const received: string[] = [];
    const server = await startServer((message, client) => {
      if (message === "SUB|") {
        client.write(encoded.subarray(0, 4));
        setTimeout(() => client.write(encoded.subarray(4)), 20);
      }
    });
    cleanups.push(server.close);
    const ns = newSocket(server.port, {
      onUnsolicitedData: pipeFrameConsumer(received),
    });

    await ns.send({ message: "SUB|", expectResponse: false });
    await vi.waitFor(() => expect(received).toEqual([text]));
  });

  it("resolves a response-less request and keeps serving the queue", async () => {
    const received: string[] = [];
    const server = await echoServer();
    const ns = newSocket(server.port, {
      onUnsolicitedData: pipeFrameConsumer(received),
    });

    await expect(
      ns.send({ message: "FIRE|", expectResponse: false }),
    ).resolves.toBe("");
    await vi.waitFor(() => expect(received).toEqual(["FIRE"]));

    const response = await ns.send({
      message: "NEXT|",
      fulfill: "NEXT|".length,
    });
    expect(response).toBe("NEXT|");
  });

  it("routes the remainder after a claimed response to the consumer", async () => {
    const received: string[] = [];
    const server = await startServer((message, client) => {
      if (message === "AUTH|") {
        client.write("OK|push|");
      }
    });
    cleanups.push(server.close);
    const ns = newSocket(server.port, {
      onUnsolicitedData: pipeFrameConsumer(received),
    });

    await expect(
      ns.send({ message: "AUTH|", fulfill: "OK|".length }),
    ).resolves.toBe("OK|");
    await vi.waitFor(() => expect(received).toEqual(["push"]));
  });

  it("reconnects with an empty queue while a consumer is set", async () => {
    const received: string[] = [];
    const server = await startServer((message, client) => {
      if (message === "SUB|") {
        client.write("hello|");
      }
    });
    cleanups.push(server.close);
    const ns = newSocket(server.port, {
      connectionRetryInterval: 20,
      onUnsolicitedData: pipeFrameConsumer(received),
    });

    await ns.send({ message: "SUB|", expectResponse: false });
    await vi.waitFor(() => expect(received).toEqual(["hello"]));

    // Nothing is pending, which used to stop the reconnect entirely.
    server.clients[0]?.destroy();
    await vi.waitFor(() => expect(server.clients).toHaveLength(2), {
      timeout: 2000,
    });
  });

  it("writes the queue head once per connection", async () => {
    const received: string[] = [];
    const server = await startServer((message, client) => {
      for (const _ of message.matchAll(/SUB\|/g)) {
        client.write("ok|");
      }
    });
    cleanups.push(server.close);

    const ns: NaiveSocket = newSocket(server.port, {
      connectionRetryInterval: 20,
      onUnsolicitedData: pipeFrameConsumer(received),
      onConnectionStateChanged: ({ state }) => {
        if (state === ConnectionState.Connected) {
          // Replaying a subscription on reconnect: this runs inside
          // onConnect, which then resumes the queue itself.
          void ns.send({ message: "SUB|", expectResponse: false });
        }
      },
    });

    await ns.send({ message: "SUB|", expectResponse: false });
    await vi.waitFor(() => expect(received).toHaveLength(2));

    // Reconnect with an empty queue, which is a subscriber's normal state.
    server.clients[0]?.destroy();
    await vi.waitFor(() => expect(server.clients).toHaveLength(2), {
      timeout: 2000,
    });
    await vi.waitFor(() => expect(received).toHaveLength(3));

    // Two on the first connection (explicit + replay), one on the second.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.messages.join("").match(/SUB\|/g)).toHaveLength(3);
  });

  it("logs and clears the buffer when the consumer throws", async () => {
    const errorLog = vi.fn();
    const server = await startServer((message, client) => {
      if (message === "SUB|") {
        client.write("boom|");
      }
    });
    cleanups.push(server.close);
    const ns = newSocket(server.port, {
      logger: { ...nullLogger, error: errorLog },
      onUnsolicitedData: () => {
        throw new Error("bad frame");
      },
    });

    await ns.send({ message: "SUB|", expectResponse: false });
    await vi.waitFor(() => expect(errorLog).toHaveBeenCalled());
  });
});
