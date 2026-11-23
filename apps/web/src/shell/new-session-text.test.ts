import { expect, test } from "bun:test";
import {
  askNewSession,
  type FirstMessage,
  listenNewSession,
} from "./new-session-text";

test("what a plugin asks the New session composer for reaches it while it listens, and only then", () => {
  const heard: FirstMessage[] = [];

  const stop = listenNewSession((first) => {
    heard.push(first);
  });

  const template = {
    key: "template:slide-deck",
    icon: "file-text" as const,
    title: "Slide deck",
    detail: "template · Slides",
    text: "The template (slide-deck)",
  };

  askNewSession("Start from the Slide deck template.", [template]);
  askNewSession("");
  stop();
  askNewSession("Too late");

  expect(heard).toEqual([
    { text: "Start from the Slide deck template.", attachments: [template] },
    { text: "", attachments: [] },
  ]);
});
