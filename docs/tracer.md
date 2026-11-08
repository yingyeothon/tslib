# Debug tracing

What a debug build of a game leaves behind for whoever has to work out what went
wrong: the steps before it, a continuous log, a screenshot, and the player's own
words. This page owns how `tracer-client` wires that into a web game or a Node
server; tracer itself — the ingest, its quotas, the read API and the `yyt tracer`
commands — belongs to the `service` repository (`docs/tracer.md` there, whose
_Wire contract for client libraries_ this package implements).

**Reference:** [`tracer-client`](../packages/tracer-client/README.md) carries
every option, the answer-by-answer behaviour and the limits.

## Breadcrumbs, logs and reports

Three kinds of data, kept differently because they are read differently:

| Call                 | Leaves the device                                      | Read it with                             |
| -------------------- | ------------------------------------------------------ | ---------------------------------------- |
| `breadcrumb`         | only inside the next report (a ring of the newest 500) | `yyt tracer event <id>`                  |
| `log`                | in batches of 100 lines or every 5 s                   | `yyt tracer logs`, `yyt tracer timeline` |
| `trace`              | both of the above                                      | both                                     |
| `report`, `feedback` | at once                                                | `yyt tracer issues`, `yyt tracer events` |

Use `trace` for the steps a reader will want both in the timeline and in the
report — a room joined, a turn played — and send a `report` (level `warning` by
default) at the moment the game notices something wrong, not only when it throws:
a report is the only thing that carries the breadcrumb trail.

## Wiring a web game

```ts
import {
  attachBrowserHooks,
  captureCanvasScreenshot,
  createTracerClient,
} from "@yingyeothon/tracer-client";

export const tracer = createTracerClient({
  dsn: import.meta.env.VITE_TRACER_DSN ?? "", // empty in release builds: off
  release: `my-game@${version}`,
  dist: import.meta.env.VITE_GIT_SHA,
  environment: "debug",
});
attachBrowserHooks(tracer); // error breadcrumbs, flush when the tab hides

// a debug "report this" button
button.onclick = async () => {
  const eventId = await tracer.report("player report", {
    screenshot: await captureCanvasScreenshot(canvas),
  });
  await tracer.feedback(prompt("What happened?") ?? "", { eventId });
};
```

Build with the DSN from the CLI, never from a file in the repository:
`VITE_TRACER_DSN="$(yyt tracer dsn <res>)" VITE_GIT_SHA="$(git rev-parse --short HEAD)" vite build`.
**A browser cannot read tracer's answers**: tracer sends no CORS headers, so the
client sends a CORS-simple `no-cors` request that arrives and is stored but whose
status is opaque — a rotated key or an exhausted quota does not stop a browser
client. [`tracer-client` § Sending from a browser](../packages/tracer-client/README.md#sending-from-a-browser)
has the details.

## Wiring a server or a Lambda

Feed the logger the code already uses into the client, and flush before the
handler returns, because a frozen Lambda sends nothing:

```ts
import {
  combine,
  consoleWriter,
  createFilteredLogger,
} from "@yingyeothon/logger";
import {
  createTracerClient,
  createTracerLogWriter,
} from "@yingyeothon/tracer-client";

const tracer = createTracerClient({
  dsn: process.env.TRACER_DSN ?? "",
  release,
});
const logger = createFilteredLogger({
  severity: "info",
  writer: combine(consoleWriter, createTracerLogWriter(tracer)),
});

export const handler = async (event: unknown) => {
  try {
    return await handle(event, logger);
  } catch (error) {
    await tracer.report("handler failed", { error, level: "error" });
    throw error;
  } finally {
    await tracer.flush({ timeoutMillis: 2000 });
  }
};
```

`flush` never waits out a back-off, so a Lambda over its quota still returns on
time. The rules in [Logging § What must never be logged](logging.md#what-must-never-be-logged)
apply to everything sent here: tracer is a debug store, not a place for tokens or
players' names.

Next: [Troubleshooting](troubleshooting.md) maps a symptom to the one check that
explains it.
