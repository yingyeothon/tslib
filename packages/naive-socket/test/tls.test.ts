import { createServer, type Server } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { nullLogger } from "@yingyeothon/logger";
import { createNaiveSocket } from "../src/index.js";

// A self-signed certificate for 127.0.0.1, valid for 100 years, so the
// TLS path can be exercised without an external fixture or a CA.
const key = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQCR90iFOsN7hMO3
G909UQEmvHI8fd3cIgB35sqN5LBgEoZUZEE3y8irfc3kmemUzb6SAxn8K4w79vos
7hxh9m4LjFJ/bBZRKCE96LhIKwat0QxlUTftGMR+1q0sLeM+gQU4HBxQC1n7YLNq
mXPy9gbdTPNtivasXf9eKlTVC8KYCmdwFkg5fXQNvANA2RxhiSrk3r9bmRy3BaA8
c5OSME4BGSVl229Ugm0iqQeYEyHeKDalNDWTJKbqwLhqBMRTi4+mrXDrCrmX+T3R
iW1oQgpchPhnrwVSBd9sX0hes8k8GBGNxXKgxe/aWe8c0z83xuFtn4Ef6S6D2uCB
TuY/wL8XAgMBAAECggEAIkQT4TrnUyLasyy2ZkOS6p4Ij0zY/Wl6BKvIV0EdaqBO
qpcSfF+5jxCsegLrw8P8/df+jKVIeXdESbHoNdMdCFb7svAT2R97lkYApOh82+cc
atiDMYTD9Ca/ZoSrOSwepopq1xujFxEfbWHyx1GcUO1UpB2gRNyYK2nymkT1fK1x
zwHbun3Y246GyeGmwyJTorILujQZbyhnTO70Sww26ox3GfMiFMsJVa/KAKdkIl5l
S4zMxoSsP2mWnwHTn+pgbRIiT4hwjI/0usjihHtGpJyXQdIKqRZiDtfXWveGaP3w
P/Sv5ov4dKBzzPcCtIts1dKnka6cPrZyfebX5Ee0AQKBgQDEpwYa4XeQpxEn14bV
c/XD0vOjUaFHkJvKmlA7Xgtae5gG1B+Siv21huQRbAdRR4oJ7SbDpow+jp2N/0sP
ayHkjSFTVCAA/L8muORXp2ES+TyyZtkg9yXltBRMhvCa+5vCYLVL8SH6EYdtx8mw
NWUyOYJ7+/UdwWAHLNp3zC1tFwKBgQC+BFKBxGuZqhFmrY2R4FRGn1fxJ5Ki/nsq
Ur8SFZ5v/VHV5bW9EsfSkbeOJpCvdoLkMBsEevkJoRx1meypx7/OSPo64XdkC0C5
fH0g2I9ybDsDjfet0y2py9RXGPVTe5EjVR2ZKZxbE4kZ07e2yQoWWSUZs4zNKhEA
S0OhiG5+AQKBgQCWdrVVG+4/35Rgx6eC6pbAnkeMToj4GM0a17dLtUk6khZgIy2F
EpPMsMkQC3gN2I7lyW4/hM8JjlU+sHbd9TqZhOJav6M9HiWjmxQbfRXpTooCdm7r
qi508rQVWan+60TiFNyinn1AuOjGNnc7O5+SLi6Ibt+9RJgU5VzDDJY1QQKBgQCU
hJxYgUX43UysjIpSspwsdu8ttliOvYlXE0X0xKEJt133aYwbNEqq8uodWVdNTbwQ
zujPH673L84mvSCVs2LfwXqT+xZuQ71bPUowGhREwwN9S8GDQ8Q1KvPU/9UAY1yV
2TlBNZzYMvS+ExVM8OXJgfPVmtk6ot6W9DzwTMrQAQKBgQCMO7tDMreFBiRGcvRq
dY8KDg0lSIHwPbQpQXjXzTaZuq1my+VdTtD4c1M+Dk6MlFc4UoqbTm2x3sc65PPp
HRnwPXx3PDZw7hwLsKTK9M7fz6QfXMkLsnaR/0R+pHkR5ujBnrZ+p4fJnBhCEF/r
Et2ozItzHTHJLSOLOppMOEFcmA==
-----END PRIVATE KEY-----`;

const cert = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIURekwFOM/2sZCfYS6hVvyW8X6vjcwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDgyNTA3NDQzOVoYDzIxMjYw
ODAxMDc0NDM5WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCR90iFOsN7hMO3G909UQEmvHI8fd3cIgB35sqN5LBg
EoZUZEE3y8irfc3kmemUzb6SAxn8K4w79vos7hxh9m4LjFJ/bBZRKCE96LhIKwat
0QxlUTftGMR+1q0sLeM+gQU4HBxQC1n7YLNqmXPy9gbdTPNtivasXf9eKlTVC8KY
CmdwFkg5fXQNvANA2RxhiSrk3r9bmRy3BaA8c5OSME4BGSVl229Ugm0iqQeYEyHe
KDalNDWTJKbqwLhqBMRTi4+mrXDrCrmX+T3RiW1oQgpchPhnrwVSBd9sX0hes8k8
GBGNxXKgxe/aWe8c0z83xuFtn4Ef6S6D2uCBTuY/wL8XAgMBAAGjbzBtMB0GA1Ud
DgQWBBSp1UabNPcZ5mxkjorFZ4uW63PTUTAfBgNVHSMEGDAWgBSp1UabNPcZ5mxk
jorFZ4uW63PTUTAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGHBH8AAAGCCWxv
Y2FsaG9zdDANBgkqhkiG9w0BAQsFAAOCAQEAUAlE2c4jBymdveUHsjjikx5WgN5x
IC1rDqDe+2PqDS6y1C3Xl1HaUDnLHYtSBDrkCuQk8oBLYrGkv8/Md47VG0rzUExK
2Iyj/BjdIyv47H/IQhn5a9ORF0DfhvX/rswGTrNiGbsKp+RYihBrj1Agm6PNCi+S
v6fxByZEAstsJLX4HPFxQ+WQJi6hctkoygCadz7ymOGBa/qv2kgxY67XOnWOcVFn
Ruq5TSLDHnWwhDojhZ8f8imsfeyy+a2rQxNC8dF5+nQH1Ng6LWvZ1xXSiee4JeTQ
/78GI3hQd6SDh3L1pYSdcE6JPdAuqCEtekAbixP0dfDUNYax48bLx/VH7Q==
-----END CERTIFICATE-----`;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

function tlsEchoServer(): Promise<{ port: number; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer({ key, cert }, (client) => {
      client.on("data", (chunk: Buffer) => client.write(chunk));
      client.on("error", () => undefined);
    });
    cleanups.push(
      () =>
        new Promise((done) => {
          server.close(() => done());
        }),
    );
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : 0,
        server,
      });
    });
  });
}

describe("tls", () => {
  it("completes a request over a TLS connection", async () => {
    const { port } = await tlsEchoServer();
    const socket = createNaiveSocket({
      host: "127.0.0.1",
      port,
      logger: nullLogger,
      tls: { ca: cert },
    });

    expect(
      await socket.send({ message: "PING|", fulfill: "PING|".length }),
    ).toBe("PING|");
    socket.disconnect();
  });

  it("keeps working across an urgent request and a second write", async () => {
    const { port } = await tlsEchoServer();
    const socket = createNaiveSocket({
      host: "127.0.0.1",
      port,
      logger: nullLogger,
      tls: { ca: cert },
    });

    const first = socket.send({ message: "one|", fulfill: "one|".length });
    const urgent = socket.send({
      message: "two|",
      fulfill: "two|".length,
      urgent: true,
    });
    expect(await urgent).toBe("two|");
    expect(await first).toBe("one|");
    socket.disconnect();
  });

  it("rejects a certificate that does not verify", async () => {
    const { port } = await tlsEchoServer();
    const socket = createNaiveSocket({
      host: "127.0.0.1",
      port,
      logger: nullLogger,
      connectionRetryInterval: -1,
      // No `ca`, so the self-signed certificate cannot be verified.
      tls: true,
    });

    await expect(
      socket.send({
        message: "PING|",
        fulfill: "PING|".length,
        timeoutMillis: 1000,
      }),
    ).rejects.toThrow();
    socket.disconnect();
  });

  it("stays cleartext when tls is unset", async () => {
    const { createServer: createPlainServer } = await import("node:net");
    const seen: string[] = [];
    const server = createPlainServer((client) => {
      client.on("data", (chunk) => {
        seen.push(chunk.toString("utf-8"));
        client.write(chunk);
      });
    });
    cleanups.push(
      () =>
        new Promise((done) => {
          server.close(() => done());
        }),
    );
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });

    const socket = createNaiveSocket({
      host: "127.0.0.1",
      port,
      logger: nullLogger,
    });
    expect(
      await socket.send({ message: "PING|", fulfill: "PING|".length }),
    ).toBe("PING|");
    // The server read the request verbatim, which is the whole hazard the
    // `tls` option exists to close.
    expect(seen).toEqual(["PING|"]);
    socket.disconnect();
  });
});
