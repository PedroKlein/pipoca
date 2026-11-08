import { expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { definePlugin } from "../src/definition";
import { defineWeb, SessionTab } from "./index";
import { renderPart } from "./testing";

const tabs = definePlugin({
  id: "tabs",
  title: "Tabs",
  description: "Fills two tabs of a Session's panel.",
});

function Header(): ReactElement {
  return (
    <>
      <SessionTab
        name="later"
        order={20}
        label="Files 2"
        button="Files"
        icon="paperclip"
      >
        <p>the files</p>
      </SessionTab>
      <SessionTab
        name="first"
        order={10}
        label="Artifacts 1"
        button="Artifacts"
        icon="paperclip"
      >
        <p>the artifacts</p>
      </SessionTab>
    </>
  );
}

const web = defineWeb(tabs, { slots: { "session.header": Header } });

test("a header button opens its tab in the one panel, whose tabs switch between plugins' contents", () => {
  const page = renderPart(web, "session.header", {});

  expect(page.querySelector("[role=dialog]")).toBeNull();

  act(() => {
    page.querySelector<HTMLButtonElement>("button[aria-label=Files]")?.click();
  });

  const panel = page.querySelector("[role=dialog]");

  expect(panel?.getAttribute("aria-label")).toBe("Files 2");
  expect(panel?.textContent).toContain("the files");
  expect(panel?.textContent).not.toContain("the artifacts");

  const choices = [
    ...(panel?.querySelectorAll("[role=group] button") ?? []),
  ] as HTMLButtonElement[];

  expect(choices.map((each) => each.textContent)).toEqual([
    "Artifacts 1",
    "Files 2",
  ]);

  act(() => {
    choices[0]?.click();
  });

  expect(page.querySelector("[role=dialog]")?.textContent).toContain(
    "the artifacts",
  );

  act(() => {
    page
      .querySelector<HTMLButtonElement>("button[aria-label='Close panel']")
      ?.click();
  });

  expect(page.querySelector("[role=dialog]")).toBeNull();
});
