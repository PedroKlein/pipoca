import { expect, test } from "bun:test";
import type { MountedSession, ToolCall } from "@pipoca/plugins/web";
import { renderPart } from "@pipoca/plugins/web/testing";
import type { SessionEvent } from "@pipoca/protocol";
import { web } from "./index";

const running = {
  id: "r1",
  shape: "single",
  startedAt: 1,
  children: [
    {
      agent: "worker",
      task: "Check the tests",
      state: "running",
      toolCount: 1,
      activity: [{ kind: "tool", text: "ls ." }],
    },
  ],
};

const done = {
  ...running,
  endedAt: 2,
  children: [
    {
      ...running.children[0],
      state: "done",
      output: "The tests pass",
    },
  ],
};

const call: ToolCall = {
  id: "call-1",
  name: "subagent",
  args: { agent: "worker", task: "Check the tests" },
  status: "done",
  result: { text: "Started run r1", details: { runId: "r1" }, failed: false },
};

// The transcript lines of a subagent call whose result carries run.
function called(run: unknown): readonly SessionEvent[] {
  return [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: call.id,
            name: "subagent",
            arguments: call.args,
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: call.id,
        toolName: "subagent",
        content: [{ type: "text", text: "Started run r1" }],
        details: { runId: "r1", run },
        isError: false,
      },
    },
  ].map((entry, line) => ({
    type: "entry",
    line,
    entry: JSON.stringify(entry),
  }));
}

function sessionWith(events: readonly SessionEvent[]): MountedSession {
  return {
    id: "session-1",
    events: (listener) => {
      events.forEach(listener);

      return () => undefined;
    },
    send: async () => Promise.resolve(),
  };
}

function rendered(
  slot: "session.header" | "session.toolCall:subagent",
  session: MountedSession,
): HTMLElement {
  return renderPart(web, slot, { session, call });
}

const tone = (page: HTMLElement): string | null | undefined =>
  page
    .querySelector("[data-subagent-run=r1]")
    ?.getAttribute("data-subagent-tone");

test("a subagent call's card draws its run from the call's result", () => {
  const page = rendered("session.toolCall:subagent", sessionWith(called(done)));

  expect(tone(page)).toBe("done");
  expect(page.textContent).toContain("worker");
});

test("a run the transcript recorded after its call shows as recorded", () => {
  const record: SessionEvent = {
    type: "entry",
    line: 2,
    entry: JSON.stringify({
      type: "custom",
      customType: "subagents-run",
      data: done,
    }),
  };

  const page = rendered(
    "session.toolCall:subagent",
    sessionWith([...called(running), record]),
  );

  expect(tone(page)).toBe("done");
});

test("the header counts the runs the Session part last published", () => {
  const published: SessionEvent = {
    type: "live",
    event: {
      type: "plugin",
      plugin: "subagents",
      key: "runs",
      data: [running],
    },
  };

  const page = rendered(
    "session.header",
    sessionWith([...called(done), published]),
  );

  expect(page.querySelector("button")?.textContent).toBe("1 running");
});

test("a Session without runs draws nothing in the header", () => {
  expect(rendered("session.header", sessionWith([])).innerHTML).toBe("");
});
