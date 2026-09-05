import { describe, expect, it } from "vitest";
import { createKvStoreClient } from "../src/index.js";

/**
 * Round trip against a deployed state stack. Skipped unless both are set:
 *   YYT_KV_BASE_URL   e.g. https://doc-dev.yyt.life
 *   YYT_KV_TOKEN      a channel JWT (or a doc apiKey) of a project that holds
 *                     a `profile` collection (readScope/writeScope `user`) and
 *                     an `announcements` collection (readScope `project`).
 * Collection names can be overridden with YYT_KV_PROFILE / YYT_KV_ANNOUNCEMENTS.
 */
const baseUrl = process.env.YYT_KV_BASE_URL;
const token = process.env.YYT_KV_TOKEN;
const profileName = process.env.YYT_KV_PROFILE ?? "profile";
const announcementsName = process.env.YYT_KV_ANNOUNCEMENTS ?? "announcements";

describe.skipIf(!baseUrl || !token)(
  "kvstore-client against a live stage",
  () => {
    // Built lazily: the describe body runs even when every test is skipped.
    const connect = () =>
      createKvStoreClient({
        baseUrl: baseUrl!,
        token: token!,
        fetch: globalThis.fetch,
      });
    const key = `it-${Date.now().toString(36)}`;

    it("saves, reads, increments, lists and deletes my own record", async () => {
      const kv = connect();
      const mine = kv.collection(profileName).mine;
      const info = await kv.collection(profileName).info();
      expect(info.writeScope).toBe("user");

      const created = await mine.put(key, { volume: 0.5 }, { ttl: 600 });
      expect(created.created).toBe(true);
      expect(created.version).toBe(1);

      const entry = await mine.getEntry<{ volume: number }>(key);
      expect(entry).toMatchObject({ value: { volume: 0.5 }, version: 1 });
      expect(entry?.expiresAt).toBeGreaterThan(Date.now() / 1000);

      await expect(
        mine.put(key, { volume: 0 }, { ifNoneMatch: true }),
      ).rejects.toMatchObject({ status: 409, currentVersion: 1 });
      const updated = await mine.put(key, { volume: 0.7 }, { ifMatch: 1 });
      expect(updated).toMatchObject({ created: false, version: 2 });
      await expect(
        mine.put(key, { volume: 0.9 }, { ifMatch: 1 }),
      ).rejects.toMatchObject({
        status: 409,
        currentVersion: 2,
      });

      const counter = `${key}-n`;
      await mine.put(counter, 1, { ttl: 600 });
      expect(await mine.incr(counter, 2)).toMatchObject({ value: 3 });

      const page = await mine.list({ prefix: key, values: true });
      expect(page.entries.map((e) => e.key).sort()).toEqual(
        [key, counter].sort(),
      );

      await mine.delete(key);
      await mine.delete(key); // idempotent: the reader's 404 is folded away
      await mine.delete(counter);
      await expect(mine.get(key)).resolves.toBeUndefined();
    });

    it("reads announcements and cannot write them", async () => {
      const kv = connect();
      const announcements = kv.collection(announcementsName);
      const page = await announcements.list({
        values: true,
        order: "desc",
        limit: 5,
      });
      expect(Array.isArray(page.entries)).toBe(true);
      await expect(
        announcements.put(key, { title: "x" }),
      ).rejects.toMatchObject({ status: 403 });
    });
  },
);
