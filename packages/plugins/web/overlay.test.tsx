import { expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import { act, type ReactElement } from "react";
import { renderPart } from "./testing";
import { definePlugin } from "../src/definition";
import { defineWeb, useOverlay } from "./index";

const viewer = definePlugin({ id: "viewer", title: "Viewer", description: "" });

function Shown(): ReactElement {
  const { params, open, close } = useOverlay();

  return (
    <>
      <p>{params.get("artifact") ?? "nothing"}</p>
      <button
        type="button"
        onClick={() => {
          open({ artifact: "a1" });
        }}
      >
        Open
      </button>
      <button
        type="button"
        onClick={() => {
          open({ artifact: "a1", v: "2" }, { replace: true });
        }}
      >
        Version 2
      </button>
      <button type="button" onClick={close}>
        Close
      </button>
    </>
  );
}

const web = defineWeb(viewer, { slots: { overlay: Shown } });

async function step(change: () => void): Promise<void> {
  await act(async () => {
    change();
    await sleep(20);
  });
}

function press(page: HTMLElement, name: string): () => void {
  return () => {
    [...page.querySelectorAll("button")]
      .find((each) => each.textContent === name)
      ?.click();
  };
}

// One render per file: the page goes when its test ends.
test("opens over the page and Back closes it; opened by a link, it closes to the page alone", async () => {
  await step(() => {
    location.hash = "#s1";
  });

  const page = renderPart(web, "overlay", {});

  const shown = (): string | null | undefined =>
    page.querySelector("p")?.textContent;

  expect(shown()).toBe("nothing");

  await step(press(page, "Open"));

  expect(location.hash).toBe("#s1?artifact=a1");
  expect(shown()).toBe("a1");

  const opened = history.length;

  await step(press(page, "Version 2"));

  expect(location.hash).toBe("#s1?artifact=a1&v=2");
  expect(history.length).toBe(opened);

  await step(press(page, "Close"));

  expect(location.hash).toBe("#s1");
  expect(shown()).toBe("nothing");

  await step(() => {
    history.replaceState(null, "", "#plugin/artifacts?artifact=a1");
    dispatchEvent(new HashChangeEvent("hashchange"));
  });

  expect(shown()).toBe("a1");

  const before = history.length;

  await step(press(page, "Close"));

  expect(location.hash).toBe("#plugin/artifacts");
  expect(history.length).toBe(before);
  expect(shown()).toBe("nothing");
});
