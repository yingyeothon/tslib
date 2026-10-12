import { createConnection } from "node:net";
import { it, expect } from "vitest";
import { startFakeRedis } from "./fake-redis.js";
it("buffers fragmented CRLF commands and records their connection", async () => {
  const fake = await startFakeRedis(() => "+OK\r\n");
  const client = createConnection(fake.port, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    await new Promise<void>((resolve, reject) =>
      client.write("AUTH fi", (error) => (error ? reject(error) : resolve())),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.received).toEqual([]);
    await new Promise<void>((resolve, reject) =>
      client.write("xture\r", (error) => (error ? reject(error) : resolve())),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.received).toEqual([]);
    const reply = new Promise<Buffer>((resolve) =>
      client.once("data", resolve),
    );
    client.write("\nPING\r\n");
    await reply;
    expect(fake.commands).toEqual([
      { connection: 1, command: "AUTH fixture" },
      { connection: 1, command: "PING" },
    ]);
  } finally {
    client.destroy();
    await fake.close();
  }
});
