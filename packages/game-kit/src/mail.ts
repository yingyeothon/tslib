import {
  createKvStoreClient,
  isKvStoreError,
  type KvNamespace,
} from "@yingyeothon/kvstore-client";
import { emitter, kitError, type Runtime } from "./runtime.js";
import { createPoller } from "./polling.js";
import { copyJson } from "./json.js";
import type { Mail, MailLetter } from "./extended-types.js";
export function createMail(runtime: Runtime): Mail {
  const events = emitter();
  let listeners = 0;
  const seen = new Set<string>();
  let watermark = 0;
  function configured() {
    if (
      !runtime.options.config.collections?.mail ||
      !runtime.options.config.state?.url
    )
      throw kitError("mail", "not_configured");
  }
  function collection() {
    const name = runtime.options.config.collections?.mail;
    const baseUrl = runtime.options.config.state?.url;
    if (!name || !baseUrl) throw kitError("mail", "not_configured");
    if (!runtime.identity || runtime.disposed)
      throw kitError("mail", "signed_out");
    return createKvStoreClient({
      baseUrl,
      token: runtime.identity.token,
      fetch: runtime.options.fetch,
    }).collection(name);
  }
  async function readEntry<T>(ns: KvNamespace, id: string) {
    const e = await ns.getEntry<T>(id);
    return e
      ? {
          entry: e,
          letter: {
            id,
            from: e.from ?? "server",
            at: e.at ?? 0,
            value: e.value,
            ...(e.expiresAt === undefined ? {} : { expiresAt: e.expiresAt }),
          } as MailLetter<T>,
        }
      : undefined;
  }
  const mail: Mail = {
    async list<T>() {
      configured();
      return runtime.run("mail", async () => {
        const ns = collection().mine;
        const generation = runtime.generation;
        const result: MailLetter<T>[] = [];
        let cursor: string | undefined;
        const cursors = new Set<string>();
        do {
          const page = await ns.list<T>({
            values: true,
            limit: 100,
            cursor,
            order: "desc",
          });
          if (generation !== runtime.generation)
            throw kitError("mail", "signed_out");
          for (const e of page.entries)
            result.push({
              id: e.key,
              from: e.from ?? "server",
              at: e.updatedAt,
              value: e.value as T,
              ...(e.expiresAt === undefined ? {} : { expiresAt: e.expiresAt }),
            });
          cursor = page.nextCursor;
          if (cursor && cursors.has(cursor))
            throw kitError("mail", "unavailable");
          if (cursor) cursors.add(cursor);
        } while (cursor);
        return result.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
      });
    },
    async read<T>(id: string) {
      configured();
      return runtime.run(
        "mail",
        async () => (await readEntry<T>(collection().mine, id))?.letter,
      );
    },
    async claim<T>(id: string) {
      configured();
      return runtime.run("mail", async () => {
        const ns = collection().mine;
        const generation = runtime.generation;
        const e = await readEntry<T>(ns, id);
        if (!e) throw kitError("mail", "already_claimed");
        if (generation !== runtime.generation)
          throw kitError("mail", "signed_out");
        try {
          await ns.delete(id, { ifMatch: e.entry.version, missing: "error" });
        } catch (error) {
          if (
            isKvStoreError(error) &&
            (error.status === 409 || error.status === 404)
          )
            throw kitError("mail", "already_claimed");
          throw error;
        }
        return e.letter;
      });
    },
    async remove(id) {
      configured();
      return runtime.run("mail", () => collection().mine.delete(id));
    },
    async send({ to, value, ttl }) {
      configured();
      return runtime.run("mail", async () => {
        const c = collection();
        const generation = runtime.generation;
        const info = await c.info();
        if (generation !== runtime.generation)
          throw kitError("mail", "signed_out");
        if (info.writeScope !== "project")
          throw kitError("mail", "server_only");
        const id = `${runtime.identity!.userId}:${crypto.randomUUID()}`;
        await c.owner(to).put(id, copyJson(value), { ttl });
      });
    },
    on(_event, handler) {
      collection();
      listeners++;
      const off = events.on("arrived", (v) => handler(v as MailLetter));
      poll.wake();
      return () => {
        off();
        listeners--;
        if (!listeners) poll.stop();
      };
    },
  };
  const poll = createPoller(
    runtime,
    "mail",
    runtime.options.mail?.pollIntervalMs ?? 30000,
    async () => {
      const generation = runtime.generation;
      const letters = await mail.list();
      if (generation !== runtime.generation || !runtime.foreground) return;

      const arrived = letters.filter(
        (l) => l.at >= watermark && !seen.has(l.id),
      );
      watermark = Math.max(watermark, ...letters.map((l) => l.at));
      for (const letter of letters) seen.add(letter.id);
      for (const letter of arrived) {
        if (generation !== runtime.generation || !runtime.foreground) break;
        events.emit(
          "arrived",
          letter,
          () => generation === runtime.generation && runtime.foreground,
        );
      }
    },
    () => listeners > 0,
  );
  for (const name of ["change", "stop", "dispose"])
    runtime.events.on(name, () => {
      seen.clear();
      watermark = 0;
      if (name === "dispose") {
        events.clear();
        listeners = 0;
      }
    });
  return mail;
}
