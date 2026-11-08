import { describe, expect, it } from "vitest";
import { parseTracerDsn } from "../src/index.js";
import { fixtureDsn, fixtureKey } from "./support.js";

describe("parseTracerDsn", () => {
  it("parses the console's DSN", () => {
    expect(parseTracerDsn(` ${fixtureDsn} `)).toEqual({
      writeKey: fixtureKey,
      resourceId: "trc_fixture01",
      envelopeUrl: "https://trace.invalid/api/trc_fixture01/envelope/",
    });
  });

  it("keeps a port and a path prefix", () => {
    expect(
      parseTracerDsn(`https://${fixtureKey}@trace.invalid:8443/p/q/trc_abc`)
        ?.envelopeUrl,
    ).toBe("https://trace.invalid:8443/p/q/api/trc_abc/envelope/");
  });

  it("accepts http only for loopback, and only when asked", () => {
    for (const host of ["127.0.0.1:8095", "localhost", "[::1]:8095"]) {
      const dsn = `http://${fixtureKey}@${host}/trc_local01`;
      expect(parseTracerDsn(dsn)).toBeUndefined();
      expect(
        parseTracerDsn(dsn, { allowHttpLoopback: true })?.envelopeUrl,
      ).toBe(`http://${host}/api/trc_local01/envelope/`);
    }
    for (const host of ["10.0.2.2", "192.168.0.10", "trace.invalid"]) {
      expect(
        parseTracerDsn(`http://${fixtureKey}@${host}/trc_x`, {
          allowHttpLoopback: true,
        }),
      ).toBeUndefined();
    }
  });

  it.each([
    ["", "empty"],
    ["not a url", "no scheme"],
    [`ftp://${fixtureKey}@trace.invalid/trc_x`, "scheme"],
    ["https://trace.invalid/trc_x", "no key"],
    ["https://shortkey@trace.invalid/trc_x", "short key"],
    [`https://${fixtureKey}%2C@trace.invalid/trc_x`, "comma in key"],
    [`https://${fixtureKey}%22@trace.invalid/trc_x`, "quote in key"],
    [`https://${fixtureKey}%3D@trace.invalid/trc_x`, "= in key"],
    [`https://${fixtureKey}%5C@trace.invalid/trc_x`, "backslash in key"],
    [`https://${fixtureKey}%20@trace.invalid/trc_x`, "space in key"],
    [`https://${fixtureKey}%E0%A4%A@trace.invalid/trc_x`, "bad escape"],
    [`https://${fixtureKey}:secret@trace.invalid/trc_x`, "password"],
    [`https://${fixtureKey}@trace.invalid/`, "no id"],
    [`https://${fixtureKey}@trace.invalid/prj_x`, "not trc_"],
    [`https://${fixtureKey}@trace.invalid/trc_UPPER`, "uppercase id"],
    [`https://${fixtureKey}@trace.invalid/trc_x?a=1`, "query"],
    [`https://${fixtureKey}@trace.invalid/trc_x#f`, "fragment"],
  ])("refuses %s (%s) without throwing", (dsn) => {
    expect(parseTracerDsn(dsn)).toBeUndefined();
  });

  it("refuses a non-string without throwing", () => {
    expect(parseTracerDsn(undefined as unknown as string)).toBeUndefined();
    expect(parseTracerDsn({} as unknown as string)).toBeUndefined();
  });
});
