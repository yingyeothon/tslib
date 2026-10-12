import type { Runtime } from "./runtime.js";
/** One foreground poll lane; old session completions cannot rearm a new session. */
export function createPoller(
  runtime: Runtime,
  module: string,
  interval: number,
  refresh: () => Promise<void>,
  interested: () => boolean,
) {
  if (!Number.isFinite(interval) || interval < 1000)
    throw new RangeError(`${module} pollIntervalMs must be at least 1000`);
  let epoch = 0;
  let cancel = () => {};
  let flight: { epoch: number; task: Promise<void> } | undefined;
  const allowed = () =>
    runtime.foreground &&
    !!runtime.identity &&
    !runtime.disposed &&
    interested();
  function stop() {
    cancel();
    cancel = () => {};
    epoch++;
    flight = undefined;
  }
  function arm() {
    cancel();
    if (allowed()) cancel = runtime.clock.schedule(wake, interval);
  }
  function wake() {
    cancel();
    if (!allowed()) return;
    if (flight?.epoch === epoch) return;
    const mine = epoch;
    const task = Promise.resolve()
      .then(refresh)
      .finally(() => {
        if (mine === epoch) {
          flight = undefined;
          arm();
        }
      });
    flight = { epoch: mine, task };
    runtime.background(module, task);
  }
  runtime.events.on("foreground", () => {
    cancel();
    if (runtime.foreground) wake();
  });
  runtime.events.on("change", () => {
    stop();
    wake();
  });
  for (const event of ["stop", "dispose"]) runtime.events.on(event, stop);
  return { wake, stop };
}
