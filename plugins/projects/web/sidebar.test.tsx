import { expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import { renderPart } from "@pipoca/plugins/web/testing";
import { act, type ReactElement } from "react";
import { web } from "./index";

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

test("the sidebar's Assistant entry and its active Projects load the list once", async () => {
  const asked: string[] = [];
  const nav = web.pages?.[0]?.nav;
  const Items = nav?.Items;
  const Live = nav?.Live;

  if (Items === undefined || Live === undefined) {
    throw new Error("the Assistant has no sidebar parts");
  }

  const Sidebar = (): ReactElement => (
    <>
      <Items path={undefined} />
      <Live path={undefined} />
    </>
  );

  const page = renderPart(
    { ...web, slots: { "session.panel": Sidebar } },
    "session.panel",
    {},
    {
      fetch: async (url) => {
        asked.push(url);

        return Promise.resolve(
          Response.json(
            url.endsWith("/projects")
              ? [
                  {
                    id: "p1",
                    name: "Shop",
                    needsYou: 0,
                    repositories: 1,
                    coordinatorState: "idle",
                  },
                ]
              : { formerCoordinators: [] },
          ),
        );
      },
    },
  );

  await act(async () => sleep(50));

  expect(asked.filter((url) => url.endsWith("/projects"))).toEqual([
    "/api/ext/projects/projects",
  ]);

  expect(page.querySelector("#project-nav")?.textContent).toContain("Shop");
});
