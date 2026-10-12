import { copyJson } from "./json.js";
import { createPushClient } from "@yingyeothon/push-client";
import { kitError, type Runtime } from "./runtime.js";
import type {
  KitPush,
  KitPushRegisterOptions,
  PushClassification,
} from "./extended-types.js";
export function createPush(runtime: Runtime, wake: () => void) {
  let lane: Promise<unknown> = Promise.resolve();
  let binding:
    | {
        token: string;
        fcm: string;
        topic: string;
        generation: number;
        client: ReturnType<typeof createPushClient>;
      }
    | undefined;
  const enqueue = <T>(action: () => Promise<T>): Promise<T> => {
    const task = lane.catch(() => {}).then(action);
    lane = task;
    return task;
  };
  function config() {
    const config = runtime.options.config.push;
    if (!config) throw kitError("push", "not_configured");
    return config;
  }
  async function clean(old: NonNullable<typeof binding>) {
    try {
      await old.client.unregister({ token: old.fcm });
    } catch {
      runtime.logger.warn("kit push cleanup failed", {
        module: "push",
        operation: "unregister",
      });
    }
    try {
      await runtime.options.push?.topics.unsubscribe(old.topic);
    } catch {
      runtime.logger.warn("kit push cleanup failed", {
        module: "push",
        operation: "unsubscribe",
      });
    }
    if (binding === old) binding = undefined;
  }
  function cleanup() {
    const old = binding;
    if (old)
      runtime.background(
        "push",
        enqueue(() => clean(old)),
      );
  }
  for (const event of ["stop", "change", "dispose"])
    runtime.events.on(event, cleanup);
  const push: KitPush = {
    async register(options: KitPushRegisterOptions) {
      const cfg = config();
      if (!runtime.options.push?.topics)
        return Promise.reject(kitError("push", "not_configured"));
      if (!runtime.identity || runtime.disposed)
        return Promise.reject(kitError("push", "signed_out"));
      const generation = runtime.generation;
      const identity = { ...runtime.identity };
      let snapshot: KitPushRegisterOptions;
      try {
        snapshot = copyJson(options);
      } catch {
        throw kitError("push", "push_refused");
      }
      const token = snapshot.token,
        project = snapshot.project;
      return runtime.run("push", () =>
        enqueue(async () => {
          if (generation !== runtime.generation || runtime.disposed)
            throw kitError("push", "signed_out");
          if (
            binding &&
            (binding.fcm !== token || binding.token !== identity.token)
          )
            await clean(binding);
          if (generation !== runtime.generation)
            throw kitError("push", "signed_out");
          const old = {
            token: identity.token,
            fcm: token,
            topic: cfg.topic,
            generation,
            client: createPushClient({
              baseUrl: cfg.apiBase,
              channelId: cfg.channelId,
              token: identity.token,
              fetch: runtime.options.fetch,
            }),
          };
          binding = old;
          try {
            await old.client.register({ token, project });
            if (generation !== runtime.generation || runtime.disposed) {
              await clean(old);
              throw kitError("push", "signed_out");
            }
            try {
              await runtime.options.push!.topics.subscribe(cfg.topic);
            } catch {
              throw kitError("push", "unavailable");
            }
            if (generation !== runtime.generation || runtime.disposed) {
              await clean(old);
              throw kitError("push", "signed_out");
            }
          } catch (error) {
            if (binding === old) await clean(old);
            throw error;
          }
        }),
      );
    },
    async unregister() {
      config();
      return enqueue(async () => {
        if (binding) await clean(binding);
      });
    },
    classify(message): PushClassification {
      config();
      const data = message.data;
      const match = runtime.options.config.match;
      if (
        data &&
        match &&
        data.channelId === match.channelId &&
        typeof data.matchId === "string" &&
        [
          "waiting",
          "proposed",
          "confirmed",
          "expired",
          "declined",
          "failed",
        ].includes(data.state ?? "")
      ) {
        wake();
        return {
          kind: "match",
          channelId: data.channelId,
          matchId: data.matchId,
          state: data.state!,
        };
      }
      return { kind: "message", message };
    },
  };
  return { push, flush: () => lane.catch(() => {}) };
}
