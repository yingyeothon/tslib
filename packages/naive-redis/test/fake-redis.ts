import { createServer, type Server, type Socket } from "node:net";

/**
 * A scripted Redis stand-in: every inbound line is recorded in order, and
 * `reply` decides what goes back. Recovery and timing are about the sequence
 * of connections and commands, and about when an answer arrives — neither of
 * which a real server can be told to break on cue, so this runs without
 * Docker.
 */
export interface FakeRedis {
  port: number;
  readonly connections: number;
  received: string[];
  /** Destroys every accepted socket, like a server restart would. */
  dropClients: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Answers one command. Return `undefined` to answer nothing now; `client` is
 * there so a test can write the answer later and model a slow round trip.
 */
export type Reply = (
  command: string,
  context: { connection: number; client: Socket },
) => string | undefined;

export function startFakeRedis(reply: Reply): Promise<FakeRedis> {
  return new Promise((resolve) => {
    const clients: Socket[] = [];
    const received: string[] = [];
    const server: Server = createServer((client) => {
      clients.push(client);
      const connection = clients.length;
      client.on("data", (chunk) => {
        for (const line of chunk.toString("utf-8").split("\r\n")) {
          if (line.length === 0) {
            continue;
          }
          received.push(line);
          const answer = reply(line, { connection, client });
          if (answer !== undefined) {
            client.write(answer);
          }
        }
      });
      client.on("error", () => undefined);
    });
    const fake: FakeRedis = {
      port: 0,
      get connections() {
        return clients.length;
      },
      received,
      dropClients: () =>
        new Promise((done) => {
          for (const client of clients) {
            client.destroy();
          }
          // Let the client side observe the close before the next command.
          setTimeout(done, 20);
        }),
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
      fake.port = typeof address === "object" && address ? address.port : 0;
      resolve(fake);
    });
  });
}
