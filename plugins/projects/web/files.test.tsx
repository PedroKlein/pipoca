import { expect, test } from "bun:test";
import {
  AttachMenu,
  FilesRow,
  FilesSection,
  type MountedSession,
  useFilesSessions,
} from "@pipoca/plugins/web";
import { renderPart, sessionWith } from "@pipoca/plugins/web/testing";
import { act, type ReactElement } from "react";
import { web } from "./index";

// The page's change stream, which tells nothing here.
Object.assign(globalThis, {
  EventSource: class {
    addEventListener(): void {
      // Nothing changes.
    }

    close(): void {
      // Nothing to close.
    }
  },
});

const folder = {
  project: { id: "p1", name: "Billing", team: false, assistant: false },
  written: [
    {
      path: "provider-note.md",
      hash: "a".repeat(64),
      size: 1024,
      actor: "session:session-1",
      updatedAt: 0,
    },
  ],
  count: 31,
};

async function settle(done: () => boolean): Promise<void> {
  for (let tries = 0; !done() && tries < 200; tries += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

test("a Session's panel has a Project folder section with what it wrote there, which opens over the page, and the way to the whole folder", async () => {
  renderPart(
    web,
    "session.panel",
    { session: sessionWith({}) },
    {
      hash: "#session-1",
      fetch: async () => {
        await Promise.resolve();

        return Response.json(folder);
      },
    },
  );

  const button = "[aria-label='Project folder, 1 file changed here']";

  await settle(() => document.querySelector(button) !== null);

  act(() => {
    document.querySelector<HTMLButtonElement>(button)?.click();
  });

  const rows = (): HTMLButtonElement[] => [
    ...document.querySelectorAll<HTMLButtonElement>(
      "section[aria-label='Project folder'] > div button",
    ),
  ];

  expect(rows().map((each) => each.textContent)).toEqual([
    "provider-note.mdchanged here",
    "Open the Billing folder31 files",
  ]);

  act(() => {
    rows()[0]?.click();
  });

  expect(location.hash).toBe("#session-1?project=p1&path=provider-note.md");

  act(() => {
    rows()[1]?.click();
  });

  expect(location.hash).toBe("#plugin/projects/p1/folder");

  // The page takes the new address before the test ends.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});

function Listed({ own }: { readonly own: string }): ReactElement {
  const sessions = useFilesSessions(own);

  return (
    <FilesSection name="made" order={20} title="Made by Pi" count={1}>
      {() =>
        sessions.map(({ id, title }) => (
          <FilesRow key={id} name={`${id} ${title}`} onOpen={() => undefined} />
        ))
      }
    </FilesSection>
  );
}

const ProjectParts = web.slots?.["session.panel"];

const withListed = {
  ...web,
  slots: {
    "session.panel": ({ session }: { readonly session: MountedSession }) => (
      <>
        {ProjectParts !== undefined && <ProjectParts session={session} />}
        <Listed own={session.id} />
      </>
    ),
  },
};

test("a coordinator's Files list every thread's, and the Thread filter picks one", async () => {
  renderPart(
    withListed,
    "session.panel",
    { session: sessionWith({}) },
    {
      fetch: async () => {
        await Promise.resolve();

        return Response.json({
          ...folder,
          written: [],
          threads: [
            { id: "t1", title: "Compare latency" },
            { id: "t2", title: "Fix checkout" },
          ],
        });
      },
    },
  );

  await settle(
    () => document.querySelector("button[aria-label^='Files']") !== null,
  );

  await settle(
    () =>
      document
        .querySelector("section[aria-label='Made by Pi']")
        ?.textContent.includes("t2") === true,
  );

  act(() => {
    document
      .querySelector<HTMLButtonElement>("button[aria-label^='Files']")
      ?.click();
  });

  const rows = (): string[] =>
    [
      ...document.querySelectorAll(
        "[role=complementary] section[aria-label='Made by Pi'] button",
      ),
    ].map((each) => each.textContent);

  expect(rows()).toEqual([
    "session-1 Coordinator",
    "t1 Compare latency",
    "t2 Fix checkout",
  ]);

  const thread = document.querySelector<HTMLSelectElement>(
    "select[aria-label=Thread]",
  );

  expect([...(thread?.options ?? [])].map((each) => each.textContent)).toEqual([
    "All threads",
    "Coordinator",
    "Compare latency",
    "Fix checkout",
  ]);

  act(() => {
    if (thread !== null) {
      thread.value = "t2";
      thread.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  expect(rows()).toEqual(["t2 Fix checkout"]);
});

test("a Session outside a Project has no Project folder section", async () => {
  let asked = 0;

  renderPart(
    web,
    "session.panel",
    { session: sessionWith({}) },
    {
      hash: "#session-1",
      fetch: async () => {
        await Promise.resolve();
        asked += 1;

        return Response.json({ project: null });
      },
    },
  );

  await settle(() => asked > 0);

  expect(document.querySelector("[aria-label^='Project folder']")).toBeNull();
});

test("what Pi's turn wrote in the Project folder shows as cards that open the file, asking nothing of the server", () => {
  let asked = 0;

  const page = renderPart(
    web,
    "notice:folder_saved",
    {
      text: "Saved in the Project folder: project/provider-note.md (1 KB).",
      data: {
        projectId: "p1",
        files: [{ path: "provider-note.md", size: 1024 }],
      },
      session: sessionWith({}),
    },
    {
      hash: "#session-1",
      fetch: async () => {
        await Promise.resolve();
        asked += 1;

        return Response.json(folder);
      },
    },
  );

  const card = (): HTMLButtonElement | null =>
    page.querySelector(
      "[aria-label='Files Pi saved in the Project folder'] button",
    );

  expect(card()?.textContent).toBe("provider-note.mdproject folder · 1 KB");

  act(() => {
    card()?.click();
  });

  expect(location.hash).toBe("#session-1?project=p1&path=provider-note.md");
  expect(asked).toBe(0);
});

test("a Project folder file opens in the viewer at its current copy, steps through the folder, and offers Publish only to people who steer the Project", async () => {
  const files = ["a.md", "b.md"].map((path, at) => ({
    path,
    hash: String(at).repeat(64),
    size: 4,
    actor: "user:ana",
    by: "Ana",
    updatedAt: 0,
  }));

  let steers = false;

  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?project=p1&path=a.md",
      fills: {
        "file.actions": ({ session }: { readonly session: string }) => (
          <span data-publish={session} />
        ),
      },
      fetch: async (url) => {
        await Promise.resolve();

        return Response.json(
          url.endsWith("/files")
            ? { files }
            : { id: "p1", coordinatorId: "c1", steers },
        );
      },
    },
  );

  await settle(() => page.querySelector("iframe") !== null);

  expect(page.querySelector("iframe")?.getAttribute("src")).toBe(
    `/api/ext/projects/projects/p1/file/view?path=a.md`,
  );

  expect(page.textContent).toContain("1 of 2 files in the folder");
  expect(page.querySelector("[data-publish]")).toBeNull();
  expect(page.textContent).not.toContain("Publish it as an artifact");

  act(() => {
    dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
  });

  expect(location.hash).toBe("#session-1?project=p1&path=b.md");

  steers = true;

  act(() => {
    history.replaceState(null, "", "#session-1?project=p2&path=a.md");
    dispatchEvent(new HashChangeEvent("hashchange"));
  });

  await settle(() => page.querySelector("[data-publish]") !== null);

  expect(
    page.querySelector("[data-publish]")?.getAttribute("data-publish"),
  ).toBe("c1");
});

test("a card of a Project folder the person can't open says so in the viewer", async () => {
  const page = renderPart(
    web,
    "overlay",
    {},
    {
      hash: "#session-1?project=p1&path=a.md",
      fetch: async () => {
        await Promise.resolve();

        return Response.json({ error: "no Project p1" }, { status: 404 });
      },
    },
  );

  await settle(() => page.textContent.includes("can't open"));

  expect(page.textContent).toContain("You can't open this Project's folder.");
});

test("the + menu attaches a Project folder file as text that tells Pi where it is, and has no row outside a Project", async () => {
  const Fill = web.slots?.["session.attach"];
  const added: unknown[] = [];

  const slots = {
    attach: () =>
      Fill === undefined ? null : (
        <AttachMenu label="Attach files" onFiles={() => undefined}>
          <Fill
            session={sessionWith({})}
            add={(attachment) => {
              added.push(attachment);
            }}
          />
        </AttachMenu>
      ),
  };

  const open = (): void => {
    act(() => {
      document
        .querySelector<HTMLButtonElement>("button[aria-label='Attach files']")
        ?.click();
    });
  };

  const row = (label: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (each) => each.textContent === label,
    );

  renderPart(
    { ...web, slots },
    "attach",
    {},
    {
      hash: "#session-1",
      fetch: async (url) => {
        await Promise.resolve();

        return Response.json(
          url.endsWith("/files")
            ? {
                files: [
                  { path: "p95-history.csv", hash: "b".repeat(64), size: 154 },
                ],
              }
            : folder,
        );
      },
    },
  );

  await settle(() => {
    open();

    return row("From the Billing folder…") !== undefined;
  });

  act(() => {
    row("From the Billing folder…")?.click();
  });

  await settle(() => row("p95-history.csv154 B") !== undefined);

  act(() => {
    row("p95-history.csv154 B")?.click();
  });

  expect(added).toEqual([
    {
      key: "project:p95-history.csv",
      title: "p95-history.csv",
      icon: "folder",
      detail: "from project/ · already saved",
      text: `Attached: "p95-history.csv" from the Project's shared folder; list_project_files gives its full path.`,
    },
  ]);
});

test("a Session outside a Project has no folder row in the + menu", async () => {
  const Fill = web.slots?.["session.attach"];
  let asked = 0;

  const slots = {
    attach: () =>
      Fill === undefined ? null : (
        <AttachMenu label="Attach files" onFiles={() => undefined}>
          <Fill session={sessionWith({})} add={() => undefined} />
        </AttachMenu>
      ),
  };

  renderPart(
    { ...web, slots },
    "attach",
    {},
    {
      hash: "#session-1",
      fetch: async () => {
        await Promise.resolve();
        asked += 1;

        return Response.json({ project: null });
      },
    },
  );

  await settle(() => asked > 0);

  act(() => {
    document
      .querySelector<HTMLButtonElement>("button[aria-label='Attach files']")
      ?.click();
  });

  expect(
    [...document.querySelectorAll("[role=group] button")].map(
      (each) => each.textContent,
    ),
  ).toEqual([]);
});
