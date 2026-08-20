import { createListDocument } from "@yingyeothon/repository";
import { expect } from "vitest";
import { fixture } from "./fixture.js";

interface KeyValue {
  key: string;
  value: string;
}

fixture("list-doc", async (repo) => {
  await repo.delete("list-doc");
  const listDoc = createListDocument<KeyValue>({
    repository: repo,
    key: "list-doc",
  });

  const first = { key: "hello", value: "world" };
  const second = { key: "hi", value: "world" };
  const third = { key: "hi", value: "there" };

  const empty = await listDoc.read();
  expect(empty.version).toEqual(0);
  expect(empty.content).toEqual([]);

  await listDoc.insert(first);
  const one = await listDoc.read();
  expect(one.version).toEqual(1);
  expect(one.content).toEqual([first]);

  await listDoc.insert(second);
  const two = await listDoc.read();
  expect(two.version).toEqual(2);
  expect(two.content).toEqual([first, second]);

  await listDoc.insert(third);
  const three = await listDoc.read();
  expect(three.version).toEqual(3);
  expect(three.content).toEqual([first, second, third]);

  await listDoc.deleteIf((each) => each.value === "world");
  const oneAgain = await listDoc.read();
  expect(oneAgain.version).toEqual(4);
  expect(oneAgain.content).toEqual([third]);

  await listDoc.truncate();
  const emptyAgain = await listDoc.read();
  expect(emptyAgain.version).toEqual(0);
  expect(emptyAgain.content).toEqual([]);
});
