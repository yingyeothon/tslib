import { expect } from "vitest";
import { fixture } from "./fixture.js";

interface Session {
  id: string;
  expiresIn: number;
}

fixture("get-set", async (repo) => {
  const key = "test-key-1";
  const value: Session = {
    id: "tester",
    expiresIn: 600,
  };

  const maybeNull = await repo.get<Session>(key);
  expect(maybeNull).toBeUndefined();

  await repo.set(key, value);
  const maybeSession = await repo.get<Session>(key);
  expect(maybeSession).toEqual(value);

  await repo.delete(key);
  const deleted = await repo.get<Session>(key);
  expect(deleted).toBeUndefined();
});

function sleep(millis: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, millis));
}

fixture("set-with-expire", async (repo) => {
  const key = "test-key-2";
  const value: Session = {
    id: "tester",
    expiresIn: 600,
  };

  const maybeNull = await repo.get<Session>(key);
  expect(maybeNull).toBeUndefined();

  const ttl = 50;
  await repo.setWithExpire(key, value, ttl);
  const maybeSession = await repo.get<Session>(key);
  expect(maybeSession).toEqual(value);

  await sleep(ttl + 1);
  const maybeExpired = await repo.get<Session>(key);
  expect(maybeExpired).toBeUndefined();
});
