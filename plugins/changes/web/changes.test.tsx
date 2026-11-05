import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { MountedSession } from "@pipoca/plugins/web";

// React reads the page when it loads, so it loads after the page exists.
GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TestShell } = await import("@pipoca/plugins/web/testing");
const { about } = await import("../about");
const { default: part } = await import("./index");

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

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

// A Session whose part published each key's data, as its stream replays it.
function sessionWith(
  published: readonly { plugin: string; key: string; data: unknown }[],
): MountedSession {
  return {
    id: "session-1",
    events: (listener) => {
      for (const event of published) {
        listener({ type: "live", event: { type: "plugin", ...event } });
      }

      return () => undefined;
    },
    send: async () => Promise.resolve(),
  };
}

function rendered(
  session: MountedSession,
  fills?: Parameters<typeof TestShell>[0]["fills"],
): HTMLElement {
  const Header = part.slots?.["session.header"];

  if (Header === undefined) {
    throw new Error("changes draws nothing in the header");
  }

  const container = document.createElement("div");
  document.body.append(container);

  act(() => {
    createRoot(container).render(
      createElement(TestShell, {
        plugin: about,
        ...(fills && { fills }),
        children: createElement(Header, { session }),
      }),
    );
  });

  return container;
}

test("the header shows what the Session part last published under changes", () => {
  const page = rendered(
    sessionWith([
      { plugin: "changes", key: "changes", data: [] },
      { plugin: "other", key: "changes", data: [checkout, checkout] },
      { plugin: "changes", key: "changes", data: [checkout] },
    ]),
  );

  expect(page.querySelector("button")?.getAttribute("aria-label")).toBe(
    "Diff, 1 file changed",
  );

  expect(page.querySelector("[role=dialog] h3")?.textContent).toContain(
    "Changes (1 file)",
  );
});

test("a Session that changed nothing draws nothing in the header", () => {
  const page = rendered(
    sessionWith([{ plugin: "changes", key: "changes", data: [] }]),
  );

  expect(page.innerHTML).toBe("");
});

test("an open pull request's status slot is empty without a plugin to fill it", () => {
  const page = rendered(
    sessionWith([
      { plugin: "changes", key: "changes", data: [checkout] },
      { plugin: "changes", key: "pull-requests", data: [opened] },
    ]),
  );

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
    sessionWith([
      { plugin: "changes", key: "changes", data: [checkout] },
      { plugin: "changes", key: "pull-requests", data: [opened] },
    ]),
    { "pullRequest.status": Status as never },
  );

  expect(page.querySelector("[data-status]")?.getAttribute("data-status")).toBe(
    opened.url,
  );
});
