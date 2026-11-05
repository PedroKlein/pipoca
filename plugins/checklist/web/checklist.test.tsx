import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { MountedSession } from "@pipoca/plugins/web";

// React reads the page when it loads, so it loads after the page exists.
GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Hidden } = await import("@pipoca/plugins/web");
const { web: part } = await import("./index");

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

type Status = "pending" | "in_progress" | "completed";

// A Session whose transcript has an update_checklist call for each list.
function sessionWith(
  results: readonly { statuses: readonly Status[]; isError?: boolean }[],
): MountedSession {
  const entries = results.flatMap(({ statuses, isError = false }, at) => {
    const id = `call-${String(at)}`;

    const items = ["Read the code", "Write the fix", "Run the tests"].map(
      (text, step) => ({ text, status: statuses[step] }),
    );

    return [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id, name: "update_checklist", arguments: {} },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: id,
          toolName: "update_checklist",
          content: [{ type: "text", text: "Checklist updated" }],
          details: isError ? {} : { items },
          isError,
        },
      },
    ];
  });

  return {
    id: "session-1",
    events: (listener) => {
      entries.forEach((entry, line) => {
        listener({ type: "entry", line, entry: JSON.stringify(entry) });
      });

      return () => undefined;
    },
    send: async () => Promise.resolve(),
  };
}

function rendered(session: MountedSession): HTMLElement {
  const Composer = part.slots?.["session.composer"];

  if (Composer === undefined) {
    throw new Error("the checklist draws nothing above the composer");
  }

  const container = document.createElement("div");
  document.body.append(container);

  act(() => {
    createRoot(container).render(createElement(Composer, { session }));
  });

  return container;
}

test("the composer pins the list of the last call that didn't fail", () => {
  const page = rendered(
    sessionWith([
      { statuses: ["completed", "in_progress", "pending"] },
      { statuses: ["completed", "completed", "in_progress"] },
      { statuses: ["pending", "pending", "pending"], isError: true },
    ]),
  );

  const summary = page.querySelector("section[aria-label=Checklist] button");

  expect(summary?.textContent).toContain("Run the tests");
  expect(summary?.textContent).toContain("2 of 3");
});

test("a list with every step done leaves the composer alone", () => {
  const page = rendered(
    sessionWith([
      { statuses: ["completed", "in_progress", "pending"] },
      { statuses: ["completed", "completed", "completed"] },
    ]),
  );

  expect(page.innerHTML).toBe("");
});

test("update_checklist calls are hidden from the chat", () => {
  expect(part.slots?.["session.toolCall:update_checklist"]).toBe(Hidden);
});
