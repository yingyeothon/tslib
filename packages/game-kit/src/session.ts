import {
  createAuthClient,
  createAuthNonce,
  readTokenClaims,
} from "@yingyeothon/auth-client";
import { createPlatformClient } from "@yingyeothon/platform-client";
import { kitError, mapError, type Runtime } from "./runtime.js";
import type {
  LoginAdapter,
  LoginFlow,
  Session,
  SessionIdentity,
} from "./types.js";

interface Popup {
  closed: boolean;
  close(): void;
  location: { href: string };
  history: { replaceState(data: unknown, unused: string, url: string): void };
}
interface Browser {
  open(url: string, name: string, features: string): Popup | null;
}
function popupAdapter(runtime: Runtime): LoginAdapter {
  return {
    open(startUrl, redirectUrl) {
      const browser = globalThis as unknown as Partial<Browser>;
      const popup = browser.open?.(
        startUrl,
        "_blank",
        "popup,width=600,height=720",
      );
      if (!popup) throw kitError("session", "unavailable");
      let cancelTimer = () => {};
      let settled = false;
      let rejectFlow: (reason: unknown) => void = () => {};
      const returnedUrl = new Promise<string>((resolve, reject) => {
        rejectFlow = reject;
        const poll = () => {
          if (settled) return;
          if (popup.closed) {
            settled = true;
            reject(kitError("session", "cancelled"));
            return;
          }
          try {
            const url = new URL(popup.location.href);
            const expected = new URL(redirectUrl);
            if (
              url.origin === expected.origin &&
              url.pathname === expected.pathname &&
              url.hash
            ) {
              settled = true;
              popup.history.replaceState(null, "", url.pathname + url.search);
              popup.close();
              resolve(url.href);
              return;
            }
          } catch {
            /* The OAuth origin is not readable from the game. */
          }
          cancelTimer = runtime.clock.schedule(poll, 200);
        };
        cancelTimer = runtime.clock.schedule(poll, 200);
      });
      return {
        returnedUrl,
        cancel() {
          cancelTimer();
          popup.close();
          if (!settled) {
            settled = true;
            rejectFlow(kitError("session", "cancelled"));
          }
        },
      };
    },
  };
}
export function createSession(runtime: Runtime): Session {
  let anchor: { epochMs: number; monotonic: number } | undefined;
  let expiringCancel = () => {};
  let expiredCancel = () => {};
  let activeLogin: LoginFlow | undefined;
  let syncPending: Promise<void> | undefined;
  let storageTail: Promise<void> = Promise.resolve();
  function storageAction(action: () => Promise<void>): Promise<void> {
    const task = storageTail.catch(() => {}).then(action);
    storageTail = task;
    return task;
  }
  function clearTimers() {
    expiringCancel();
    expiredCancel();
  }
  function arm() {
    clearTimers();
    const identity = runtime.identity;
    if (!identity || !anchor) return;
    const generation = runtime.generation;
    const remaining = identity.expiresAt * 1000 - session.now();
    if (remaining <= 0) {
      runtime.stop();
      return;
    }
    expiringCancel = runtime.clock.schedule(
      () => {
        if (generation === runtime.generation) runtime.events.emit("expiring");
      },
      Math.max(0, remaining - 600000),
    );
    expiredCancel = runtime.clock.schedule(() => {
      if (generation === runtime.generation) runtime.stop();
    }, remaining);
  }
  async function sync() {
    const stateUrl = runtime.options.config.state?.url;
    if (!stateUrl) return;
    const generation = runtime.generation;
    const start = runtime.clock.now();
    const time = await createPlatformClient({
      baseUrl: stateUrl,
      fetch: runtime.options.fetch,
    }).time();
    if (
      generation !== runtime.generation ||
      !runtime.identity ||
      runtime.disposed
    )
      return;
    anchor = {
      epochMs: time.epochMs,
      monotonic: (start + runtime.clock.now()) / 2,
    };
    arm();
  }
  function resync() {
    if (!syncPending && runtime.identity && !anchor) {
      syncPending = sync()
        .catch(() => {
          runtime.logger.warn("kit clock synchronization failed", {
            module: "session",
          });
        })
        .finally(() => {
          syncPending = undefined;
        });
    }
    return syncPending;
  }
  runtime.events.on("stop", () => {
    clearTimers();
    activeLogin?.cancel();
    activeLogin = undefined;
    anchor = undefined;
    if (runtime.options.tokenStorage)
      runtime.background(
        "session",
        storageAction(() => runtime.options.tokenStorage!.clear()),
      );
  });
  runtime.events.on("foreground", () => {
    if (runtime.foreground)
      runtime.background("session", Promise.resolve(resync()));
  });
  const session: Session = {
    get token() {
      return runtime.identity?.token;
    },
    get userId() {
      return runtime.identity?.userId;
    },
    get expiresAt() {
      return runtime.identity?.expiresAt;
    },
    async fromToken(jwt) {
      if (runtime.disposed) throw kitError("session", "invalid_state");
      const claims = readTokenClaims(jwt);
      const identity: SessionIdentity = {
        token: claims.jwt,
        userId: claims.userId,
        expiresAt: claims.exp,
      };
      clearTimers();
      anchor = undefined;
      activeLogin?.cancel();
      activeLogin = undefined;
      runtime.identity = identity;
      runtime.change();
      const generation = runtime.generation;
      if (runtime.options.tokenStorage) {
        try {
          await storageAction(() => runtime.options.tokenStorage!.store(jwt));
        } catch {
          throw kitError("session", "unavailable");
        }
      }
      await sync().catch(() => {
        runtime.logger.warn("kit clock synchronization failed", {
          module: "session",
        });
      });
      if (runtime.generation !== generation || !runtime.identity)
        throw kitError("session", "signed_out");
      return { ...identity };
    },
    async restore() {
      if (!runtime.options.tokenStorage) return undefined;
      const generation = runtime.generation;
      let token: string | undefined;
      try {
        token = await runtime.options.tokenStorage.load();
      } catch {
        throw kitError("session", "unavailable");
      }
      if (generation !== runtime.generation || runtime.disposed)
        throw kitError("session", "signed_out");
      return token ? session.fromToken(token) : undefined;
    },
    async signOut() {
      if (runtime.identity) {
        runtime.stop();
        await storageTail;
      } else {
        runtime.generation++;
        activeLogin?.cancel();
        if (runtime.options.tokenStorage)
          await storageAction(() => runtime.options.tokenStorage!.clear());
      }
    },
    now() {
      if (!runtime.identity || runtime.disposed)
        throw kitError("session", "signed_out");
      if (!anchor) throw kitError("session", "unavailable");
      return anchor.epochMs + runtime.clock.now() - anchor.monotonic;
    },
    on(name, handler) {
      return runtime.events.on(name, handler);
    },
    async signIn() {
      const auth = runtime.options.config.auth;
      const login = runtime.options.login;
      if (!auth || !login) throw kitError("session", "not_configured");
      if (runtime.disposed || activeLogin)
        throw kitError("session", "invalid_state");
      const client = createAuthClient({
        baseUrl: auth.url,
        channelId: auth.channelId,
        fetch: runtime.options.fetch,
      });
      const nonce = createAuthNonce();
      let flow: LoginFlow;
      try {
        flow = (login.adapter ?? popupAdapter(runtime)).open(
          client.buildStartUrl({
            provider: auth.provider ?? "github",
            redirectUrl: login.redirectUrl,
            nonce,
          }),
          login.redirectUrl,
        );
      } catch (error) {
        throw mapError("session", error);
      }
      activeLogin = flow;
      let cancelTimeout = () => {};
      try {
        const returned = await Promise.race([
          flow.returnedUrl,
          new Promise<never>((_, reject) => {
            cancelTimeout = runtime.clock.schedule(() => {
              reject(kitError("session", "unavailable"));
              flow.cancel();
            }, login.timeoutMs ?? 600000);
          }),
        ]);
        const token = client.parseRedirect({
          returnedUrl: returned,
          redirectUrl: login.redirectUrl,
          expectedNonce: nonce,
        });
        activeLogin = undefined;
        return await session.fromToken(token.jwt);
      } catch (error) {
        throw mapError("session", error);
      } finally {
        cancelTimeout();
        flow.cancel();
        if (activeLogin === flow) activeLogin = undefined;
      }
    },
  };
  runtime.events.on("dispose", () => {
    clearTimers();
    activeLogin?.cancel();
  });
  return session;
}
