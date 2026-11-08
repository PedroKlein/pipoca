import { expect, test } from "bun:test";
import { renderPart, sessionWith } from "@pipoca/plugins/web/testing";
import { web } from "./index";

test("a published artifact shows in the chat as a card that opens it", () => {
  const page = renderPart(web, "session.toolCall:publish_artifact", {
    session: sessionWith({}),
    call: {
      id: "call-1",
      name: "publish_artifact",
      args: { path: "report.md" },
      status: "done",
      result: {
        text: "Published",
        details: { id: "a1", title: "Sales report", version: 2 },
        failed: false,
      },
    },
  });

  const card = page.querySelector("[aria-label='Artifact Sales report']");

  expect(card?.textContent).toContain("Version 2");

  expect(card?.querySelector("a")?.getAttribute("href")).toBe(
    "#plugin/artifacts/a1",
  );
});

test("a publish that failed says why, with nothing to open", () => {
  const page = renderPart(web, "session.toolCall:publish_artifact", {
    session: sessionWith({}),
    call: {
      id: "call-2",
      name: "publish_artifact",
      args: { path: "notes.docx", title: "Notes" },
      status: "failed",
      result: {
        text: "notes.docx can't be an artifact",
        details: {},
        failed: true,
      },
    },
  });

  const card = page.querySelector("[aria-label='Artifact Notes']");

  expect(card?.textContent).toContain("notes.docx can't be an artifact");
  expect(card?.querySelector("a")).toBeNull();
});
