import { expect, test } from "bun:test";
import { renderPart, sessionWith } from "@pipoca/plugins/web/testing";
import { web } from "./index";

type Status = "pending" | "in_progress" | "completed";

// A Session whose transcript has an update_checklist call for each list.
function calls(
  lists: readonly { statuses: readonly Status[]; isError?: boolean }[],
): ReturnType<typeof sessionWith> {
  return sessionWith({
    toolResults: lists.map(({ statuses, isError = false }) => ({
      tool: "update_checklist",
      text: "Checklist updated",
      isError,
      details: isError
        ? {}
        : {
            items: ["Read the code", "Write the fix", "Run the tests"].map(
              (text, step) => ({ text, status: statuses[step] }),
            ),
          },
    })),
  });
}

test("the composer pins the list of the last call that didn't fail", () => {
  const page = renderPart(web, "session.composer", {
    session: calls([
      { statuses: ["completed", "in_progress", "pending"] },
      { statuses: ["completed", "completed", "in_progress"] },
      { statuses: ["pending", "pending", "pending"], isError: true },
    ]),
  });

  const summary = page.querySelector("section[aria-label=Checklist] button");

  expect(summary?.textContent).toContain("Run the tests");
  expect(summary?.textContent).toContain("2 of 3");
});

test("a list with every step done leaves the composer alone", () => {
  const page = renderPart(web, "session.composer", {
    session: calls([
      { statuses: ["completed", "in_progress", "pending"] },
      { statuses: ["completed", "completed", "completed"] },
    ]),
  });

  expect(page.innerHTML).toBe("");
});

test("update_checklist calls are hidden from the chat", () => {
  const page = renderPart(web, "session.toolCall:update_checklist", {
    session: calls([]),
    call: {
      id: "call-1",
      name: "update_checklist",
      args: {},
      status: "done",
    },
  });

  expect(page.innerHTML).toBe("");
});
