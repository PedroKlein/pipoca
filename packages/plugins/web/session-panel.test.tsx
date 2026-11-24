import { expect, test } from "bun:test";
import { act, type ReactElement, useState } from "react";
import { definePlugin } from "../src/definition";
import {
  defineWeb,
  FilesRow,
  FilesSection,
  SessionPanel,
  SessionPanelGroup,
  SessionSection,
} from "./index";
import { renderPart } from "./testing";

const sections = definePlugin({
  id: "sections",
  title: "Sections",
  description: "Fills two sections of a Session's panel.",
});

function Parts(): ReactElement {
  return (
    <>
      <SessionSection
        name="later"
        order={20}
        label="Changes"
        icon="git-pull-request"
        button="Diff, 2 files changed"
        badge="2"
        detail={<p>the whole diff</p>}
      >
        <p>2 files changed</p>
      </SessionSection>
      <SessionSection
        name="first"
        order={10}
        label="Votes"
        icon="users"
        button="Votes, 1 open vote"
        badge="1"
        waiting
      >
        <p>Ship it?</p>
      </SessionSection>
    </>
  );
}

const web = defineWeb(sections, { slots: { "session.panel": Parts } });

const click = (page: HTMLElement, label: string): void => {
  act(() => {
    page
      .querySelector<HTMLButtonElement>(`button[aria-label='${label}']`)
      ?.click();
  });
};

test("a closed panel is a rail of the sections' icons with their badges, in order", () => {
  const page = renderPart(web, "session.panel", {});

  expect(page.querySelector("[role=complementary]")).toBeNull();

  const rail = page.querySelector("nav[aria-label='Session panel']");

  expect(
    [...(rail?.querySelectorAll("button") ?? [])].map((each) => [
      each.getAttribute("aria-label"),
      each.textContent,
    ]),
  ).toEqual([
    ["Open panel", ""],
    ["Votes, 1 open vote", "1"],
    ["Diff, 2 files changed", "2"],
  ]);
});

test("the open panel lists every summary, and a title opens that section's detail", () => {
  const page = renderPart(web, "session.panel", {});

  click(page, "Open panel");

  const panel = page.querySelector("[role=complementary]");

  expect(panel?.getAttribute("aria-label")).toBe("Session");
  expect(panel?.textContent).toContain("Ship it?");
  expect(panel?.textContent).toContain("2 files changed");
  expect(panel?.textContent).not.toContain("the whole diff");

  act(() => {
    [...(panel?.querySelectorAll("h3 button") ?? [])]
      .find((each) => each.textContent === "Changes")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

  const detail = page.querySelector("[role=complementary]");

  expect(detail?.getAttribute("aria-label")).toBe("Changes");
  expect(detail?.textContent).toContain("the whole diff");
  expect(detail?.textContent).not.toContain("Ship it?");

  act(() => {
    [...(detail?.querySelectorAll("button") ?? [])]
      .find((each) => each.textContent === "All of this Session")
      ?.click();
  });

  expect(page.querySelector("[role=complementary]")?.textContent).toContain(
    "Ship it?",
  );
});

test("a rail icon opens its section's detail, and the browser remembers whether the panel is open", () => {
  const page = renderPart(web, "session.panel", {});

  click(page, "Diff, 2 files changed");

  expect(page.querySelector("[role=complementary]")?.textContent).toContain(
    "the whole diff",
  );

  expect(localStorage.getItem("pipoca.session-panel")).toBe("open");

  click(page, "Close panel");

  expect(page.querySelector("[role=complementary]")).toBeNull();
  expect(localStorage.getItem("pipoca.session-panel")).toBe("closed");
});

function Pane({ name }: { readonly name: string }): ReactElement {
  return (
    <div data-pane={name}>
      <SessionPanel>
        <button type="button">{`Steer the ${name}`}</button>
        <SessionSection
          name={name}
          order={10}
          label={name}
          icon="file"
          button={`${name} things`}
        >
          <p>{name}</p>
        </SessionSection>
      </SessionPanel>
    </div>
  );
}

function Beside(): ReactElement {
  const [thread, setThread] = useState(false);

  return (
    <SessionPanelGroup>
      <Pane name="coordinator" />
      <button
        type="button"
        aria-label="Open the thread"
        onClick={() => {
          setThread(!thread);
        }}
      />
      {thread && <Pane name="thread" />}
    </SessionPanelGroup>
  );
}

const panes = defineWeb(sections, { slots: { "session.panel": Beside } });

test("Sessions side by side share one panel, which shows the one opened or used last", () => {
  const page = renderPart(panes, "session.panel", {});

  const railed = (): (string | null)[] =>
    [...page.querySelectorAll("nav[aria-label='Session panel'] button")].map(
      (each) => each.getAttribute("aria-label"),
    );

  expect(railed()).toEqual(["Open panel", "coordinator things"]);

  click(page, "Open the thread");

  expect(railed()).toEqual(["Open panel", "thread things"]);

  act(() => {
    page
      .querySelector<HTMLButtonElement>("[data-pane=coordinator] button")
      ?.focus();
  });

  expect(railed()).toEqual(["Open panel", "coordinator things"]);

  click(page, "Open the thread");
  click(page, "Open the thread");

  expect(railed()).toEqual(["Open panel", "thread things"]);

  click(page, "Open the thread");

  expect(railed()).toEqual(["Open panel", "coordinator things"]);
});

const listed = defineWeb(sections, {
  slots: {
    "session.panel": () => (
      <FilesSection name="made" order={10} title="Made by Pi" count={4}>
        {() =>
          ["a.md", "b.md", "c.md", "d.md"].map((name) => (
            <FilesRow key={name} name={name} onOpen={() => undefined} />
          ))
        }
      </FilesSection>
    ),
  },
});

test("a summary's “more” opens the Files detail with every row", () => {
  const page = renderPart(listed, "session.panel", {});

  click(page, "Open panel");

  const rows = (): string[] =>
    [
      ...(page
        .querySelector("[role=complementary]")
        ?.querySelectorAll("section[aria-label='Made by Pi'] button") ?? []),
    ].map((each) => each.textContent);

  expect(rows()).toEqual(["a.md", "b.md", "2 more"]);

  act(() => {
    [...page.querySelectorAll<HTMLButtonElement>("button")]
      .find((each) => each.textContent === "2 more")
      ?.click();
  });

  expect(
    page.querySelector("[role=complementary]")?.getAttribute("aria-label"),
  ).toBe("Files");

  expect(rows()).toEqual(["a.md", "b.md", "c.md", "d.md"]);
});
