import { expect, test } from "bun:test";
import { renderPart, sessionWith } from "@pipoca/plugins/web/testing";
import { web } from "./index";

const notice = {
  threadId: "t1",
  title: "Async backup discussion",
  event: "finished a turn",
  runState: "idle",
  workState: "in_progress",
};

test("a thread's routine report draws nothing in the coordinator chat", () => {
  renderPart(web, "notice:thread", {
    text: "",
    data: { ...notice, quiet: true },
    session: sessionWith({}),
  });

  expect(document.body.textContent).not.toContain("Async backup discussion");
});

test("a thread whose turn failed shows in the coordinator chat", () => {
  renderPart(web, "notice:thread", {
    text: "",
    data: { ...notice, event: "ended its turn with a model error: overloaded" },
    session: sessionWith({}),
  });

  expect(document.body.textContent).toContain("model error: overloaded");
});
