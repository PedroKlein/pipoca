import { expect, test } from "bun:test";
import { renderPart, sessionWith } from "@pipoca/plugins/web/testing";
import type { ComponentType } from "react";
import { act, createElement } from "react";
import { web } from "./index";

const patch = `diff --git a/notes.txt b/notes.txt
--- a/notes.txt
+++ b/notes.txt
@@ -1 +1 @@
-old notes
+new notes
`;

const checkout = {
  name: "",
  branched: true,
  files: [{ status: "M", path: "notes.txt" }],
  fileCount: 1,
  stat: " notes.txt | 2 +-",
  patch,
  truncated: false,
};

const opened = {
  name: "",
  status: "open",
  url: "https://github.com/acme/widgets/pull/7",
};

// A Session whose part published each key's data, as its stream replays it,
// with its panel open on the changes.
function rendered(
  published: readonly { plugin: string; key: string; data: unknown }[],
  fills?: Readonly<Record<string, ComponentType<never>>>,
): HTMLElement {
  const page = renderPart(
    web,
    "session.header",
    { session: sessionWith({ published }) },
    { ...(fills && { fills }) },
  );

  act(() => {
    page.querySelector<HTMLButtonElement>("button[aria-label^=Diff]")?.click();
  });

  return page;
}

test("the header shows what the Session part last published under changes", () => {
  const page = rendered([
    { plugin: "changes", key: "changes", data: [] },
    { plugin: "other", key: "changes", data: [checkout, checkout] },
    { plugin: "changes", key: "changes", data: [checkout] },
  ]);

  expect(page.querySelector("button")?.getAttribute("aria-label")).toBe(
    "Diff, 1 file changed",
  );

  expect(page.querySelector("[role=dialog] h3")?.textContent).toContain(
    "Changes (1 file)",
  );
});

test("a Session that changed nothing draws nothing in the header", () => {
  const page = rendered([{ plugin: "changes", key: "changes", data: [] }]);

  expect(page.innerHTML).toBe("");
});

test("an open pull request's status slot is empty without a plugin to fill it", () => {
  const page = rendered([
    { plugin: "changes", key: "changes", data: [checkout] },
    { plugin: "changes", key: "pull-requests", data: [opened] },
  ]);

  const actions = page.querySelector("[role=dialog] h3")?.nextElementSibling;

  expect(
    [...(actions?.querySelectorAll("button, a") ?? [])].map(
      (each) => each.textContent,
    ),
  ).toEqual(["Push", "View PR"]);
});

test("another plugin fills an open pull request's status slot", () => {
  const Status = ({ url }: { readonly url: string }) =>
    createElement("span", { "data-status": url }, "Checks pass");

  const page = rendered(
    [
      { plugin: "changes", key: "changes", data: [checkout] },
      { plugin: "changes", key: "pull-requests", data: [opened] },
    ],
    { "pullRequest.status": Status as never },
  );

  expect(page.querySelector("[data-status]")?.getAttribute("data-status")).toBe(
    opened.url,
  );
});
