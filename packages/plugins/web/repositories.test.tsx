import { expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import { act } from "react";
import { renderPart } from "./testing";
import { definePlugin } from "../src/definition";
import { defineWeb, RepositoryField } from "./index";

const picks = definePlugin({ id: "picks", title: "Picks", description: "" });

const hour = 3_600_000;

function Field(): ReturnType<typeof RepositoryField> {
  return (
    <RepositoryField
      label="Repositories"
      selected={[]}
      recent={["https://github.tools.sap/acme/infra.git", "/home/pedro/notes"]}
      team={false}
      onChange={() => undefined}
    >
      Pick
    </RepositoryField>
  );
}

test("lists what the git hosts find with when each was pushed, and the recent ones with their host or path", async () => {
  const page = renderPart(
    defineWeb(picks, { slots: { "session.header": Field } }),
    "session.header",
    {},
    {
      repositories: [
        {
          url: "https://github.tools.sap/acme/infra.git",
          name: "acme/infra",
          group: "SAP",
          host: "github.tools.sap",
          pushedAt: new Date(Date.now() - 2 * hour).toISOString(),
          private: true,
        },
        {
          url: "https://github.com/pedro/notes.git",
          name: "pedro/notes",
          group: "GitHub",
          host: "github.com",
          language: "Go",
        },
      ],
    },
  );

  await act(async () => sleep(10));

  act(() => {
    page
      .querySelector<HTMLButtonElement>('[aria-label="Repositories"]')
      ?.click();
  });

  const option = (name: string): string =>
    page.querySelector(`[role="option"][aria-label="${name}"]`)?.textContent ??
    "";

  expect(option("acme/infra")).toBe(
    "acme/infragithub.tools.sap · pushed 2h agoPrivate host",
  );

  expect(option("pedro/notes")).toBe("pedro/notesGo");
  expect(option("notes")).toBe("notes/home/pedro/notes");
});
