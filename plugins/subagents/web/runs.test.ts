import { expect, test } from "bun:test";
import { noticeType } from "@pipoca/protocol";
import {
  type ChildView,
  finishedRun,
  manages,
  recordedRun,
  type RunView,
  separateOutput,
} from "./runs";

const child: ChildView = {
  agent: "worker",
  task: "fix it",
  state: "done",
  toolCount: 2,
  activity: [
    { kind: "tool", text: "read src/a.ts" },
    { kind: "text", text: "Fixed" },
  ],
  output: "Fixed",
};

const run: RunView = {
  id: "r1",
  shape: "single",
  startedAt: 1,
  endedAt: 2,
  children: [child],
};

test("reads a finished run from the notice that brought it back", () => {
  const entry = JSON.stringify({
    type: "custom_message",
    customType: noticeType,
    content: "Subagent run r1 ended: done.",
    details: { plugin: "subagents", kind: "finished", data: run },
  });

  expect(finishedRun({ type: "entry", entry } as never)).toEqual(run);
});

test("ignores another plugin's notice of the same kind", () => {
  const entry = JSON.stringify({
    type: "custom_message",
    customType: noticeType,
    details: { plugin: "projects", kind: "finished", data: run },
  });

  expect(finishedRun({ type: "entry", entry } as never)).toBeUndefined();
});

test("shows an output only when the child didn't already say it", () => {
  expect(separateOutput(child)).toBe("");

  expect(separateOutput({ ...child, output: "Fixed, and tested" })).toBe(
    "Fixed, and tested",
  );

  expect(separateOutput({ ...child, state: "failed", error: "no model" })).toBe(
    "no model",
  );
});

test("draws a call that names a task as a run, even with an action filled in", () => {
  expect(manages({ action: "status", id: "r1" })).toBe(true);

  expect(manages({ action: "status", agent: "scout", task: "look" })).toBe(
    false,
  );
});

test("reads a run from the record the transcript keeps of it", () => {
  const entry = JSON.stringify({
    type: "custom",
    customType: "subagents-run",
    data: run,
  });

  expect(recordedRun({ type: "entry", entry } as never)).toEqual(run);

  expect(
    recordedRun({
      type: "entry",
      entry: JSON.stringify({ type: "custom", customType: "other", data: run }),
    } as never),
  ).toBeUndefined();
});
