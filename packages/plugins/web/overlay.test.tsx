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

async function step(change: () => void, done: () => boolean): Promise<void> {
  act(change);

  // React draws only once each act ends, so wait act by act.
  for (let tries = 0; !done(); tries += 1) {
    if (tries > 100) {
      throw new Error("the page never got there");
    }

    await act(async () => sleep(10));
  }
}

function press(page: HTMLElement, name: string): () => void {
  return () => {
    [...page.querySelectorAll("button")]
      .find((each) => each.textContent === name)
      ?.click();
  };
}

// One render per file: the page goes when its test ends.
test("opens over the page, Back closes it and Forward opens it again; opened by a link, it closes to the page alone", async () => {
  const page = renderPart(web, "overlay", {}, { hash: "#s1" });

  const shown = (): string | null | undefined =>
    page.querySelector("p")?.textContent;

  expect(shown()).toBe("nothing");

  await step(press(page, "Open"), () => shown() === "a1");

  expect(location.hash).toBe("#s1?artifact=a1");

  const opened = history.length;

  await step(press(page, "Version 2"), () => location.hash.endsWith("v=2"));

  expect(location.hash).toBe("#s1?artifact=a1&v=2");
  expect(history.length).toBe(opened);

  await step(press(page, "Close"), () => shown() === "nothing");

  expect(location.hash).toBe("#s1");

  await step(
    () => {
      history.forward();
    },
    () => shown() === "a1",
  );

  expect(location.hash).toBe("#s1?artifact=a1&v=2");

  await step(
    () => {
      history.back();
    },
    () => shown() === "nothing",
  );

  await step(
    () => {
      history.replaceState(null, "", "#plugin/artifacts?artifact=a1");
      dispatchEvent(new HashChangeEvent("hashchange"));
    },
    () => shown() === "a1",
  );

  const before = history.length;

  await step(press(page, "Close"), () => shown() === "nothing");

  expect(location.hash).toBe("#plugin/artifacts");
  expect(history.length).toBe(before);
});
