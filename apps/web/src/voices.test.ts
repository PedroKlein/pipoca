import { expect, test } from "bun:test";
import type { FeedItem } from "./feed";
import { voiced } from "./voices";

const names = new Map([
  ["ana", "Ana"],
  ["bo", "Bo"],
]);

const name = (person: string): string => names.get(person) ?? "Someone";

test("names who sent each message, in the order they were sent", () => {
  const items: FeedItem[] = [
    { role: "user", text: "go", key: 0 },
    { role: "assistant", text: "ok", key: 1 },
    { role: "user", text: "go", key: 2 },
  ];

  const shown = voiced(
    items,
    [
      {
        kind: "message",
        person: "ana",
        at: "2026-11-04T05:00:00Z",
        text: "go",
      },
      { kind: "message", person: "bo", at: "2026-11-04T05:01:00Z", text: "go" },
    ],
    name,
  );

  expect(
    shown.flatMap((item) => (item.role === "user" ? [item.by] : [])),
  ).toEqual(["Ana", "Bo"]);
});

test("puts a stop, with who asked for it, where it happened", () => {
  const items: FeedItem[] = [
    { role: "user", text: "go", at: "2026-11-04T05:00:00Z", key: 0 },
    { role: "assistant", text: "ok", at: "2026-11-04T05:02:00Z", key: 1 },
  ];

  const shown = voiced(
    items,
    [{ kind: "stop", person: "bo", at: "2026-11-04T05:01:00Z" }],
    name,
  );

  expect(shown.map((item) => ("text" in item ? item.text : ""))).toEqual([
    "go",
    "Bo stopped it.",
    "ok",
  ]);
});

test("leaves a personal Session's items as they are", () => {
  const items: FeedItem[] = [{ role: "user", text: "go", key: 0 }];

  expect(voiced(items, [], name)).toBe(items);
});
