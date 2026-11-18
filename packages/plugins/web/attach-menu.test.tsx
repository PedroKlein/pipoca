import { expect, test } from "bun:test";
import { act, type ReactElement, useState } from "react";
import { definePlugin } from "../src/definition";
import { AttachMenu, AttachPicker, AttachRow, defineWeb } from "./index";
import { renderPart } from "./testing";

const attach = definePlugin({
  id: "attach",
  title: "Attach",
  description: "Adds a row to the composer's + menu.",
});

const picked: string[] = [];
const uploaded: string[] = [];

function Composer(): ReactElement {
  const [picking, setPicking] = useState(false);

  return (
    <form>
      <textarea aria-label="Message" />
      <AttachMenu
        label="Attach files"
        onFiles={(files) => {
          uploaded.push(...files.map(({ name }) => name));
        }}
      >
        <AttachRow
          icon="folder"
          label="From the folder…"
          onPick={() => {
            setPicking(true);
          }}
        />
        <AttachPicker
          open={picking}
          title="Attach a file"
          items={[
            { key: "a", title: "notes.md", detail: "1 KB" },
            { key: "b", title: "plan.md", detail: "2 KB" },
          ]}
          empty="The folder has no files yet."
          onPick={(key) => {
            picked.push(key);
          }}
          onClose={() => {
            setPicking(false);
          }}
        />
      </AttachMenu>
    </form>
  );
}

const web = defineWeb(attach, { slots: { "session.header": Composer } });

const plus = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>(
    "button[aria-label='Attach files']",
  );

const group = (): HTMLElement | null =>
  document.querySelector<HTMLElement>(
    "[role=group][aria-label='Attach files']",
  );

const key = (name: string): void => {
  act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true }),
    );
  });
};

test("the + menu opens on its first row, moves with the arrow keys, and a plugin's row closes it and opens its picker", async () => {
  picked.splice(0);
  renderPart(web, "session.header", {});

  expect(group()?.hidden).toBe(true);

  act(() => {
    plus()?.click();
  });

  expect(plus()?.getAttribute("aria-expanded")).toBe("true");
  expect(group()?.hidden).toBe(false);
  expect(document.activeElement?.getAttribute("type")).toBe("file");

  key("ArrowDown");
  expect(document.activeElement?.textContent).toBe("From the folder…");
  key("ArrowDown");
  expect(document.activeElement?.getAttribute("type")).toBe("file");
  key("End");
  expect(document.activeElement?.textContent).toBe("From the folder…");
  key("Home");
  key("ArrowUp");
  expect(document.activeElement?.textContent).toBe("From the folder…");

  act(() => {
    (document.activeElement as HTMLButtonElement | null)?.click();
  });

  expect(group()?.hidden).toBe(true);

  const search = document.querySelector<HTMLInputElement>(
    "dialog input[type=search]",
  );

  act(() => {
    if (search !== null) {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(search, "2 KB");

      search.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });

  const rows = (): HTMLButtonElement[] => [
    ...document.querySelectorAll<HTMLButtonElement>(
      "dialog ul[aria-label='Attach a file'] button",
    ),
  ];

  expect(rows().map((each) => each.textContent)).toEqual(["plan.md2 KB"]);

  // Enter takes the row the search marks, and ArrowUp from the first row
  // goes back to the search.
  expect(search?.getAttribute("aria-activedescendant")).toBe(rows()[0]?.id);

  act(() => {
    search?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
  });

  expect(document.activeElement).toBe(rows()[0] ?? null);
  expect(search?.getAttribute("aria-activedescendant")).toBeNull();
  key("ArrowUp");
  expect(document.activeElement).toBe(search);

  act(() => {
    search?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });

  expect(picked).toEqual(["b"]);

  // The message has focus again, as the row the picker came from is gone.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  expect(document.activeElement?.getAttribute("aria-label")).toBe("Message");
});

test("the + menu closes when focus leaves it", () => {
  renderPart(web, "session.header", {});

  const outside = document.createElement("button");

  document.body.append(outside);

  act(() => {
    plus()?.click();
  });

  expect(group()?.hidden).toBe(false);

  act(() => {
    outside.focus();
  });

  expect(group()?.hidden).toBe(true);
  outside.remove();
});

test("files chosen from the + menu are attached and close it", () => {
  uploaded.splice(0);
  renderPart(web, "session.header", {});

  act(() => {
    plus()?.click();
  });

  const input = document.querySelector<HTMLInputElement>(
    "[role=group] input[type=file]",
  );

  act(() => {
    if (input !== null) {
      Object.defineProperty(input, "files", {
        value: [new File(["a"], "shot.png")],
        configurable: true,
      });

      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  expect(uploaded).toEqual(["shot.png"]);
  expect(group()?.hidden).toBe(true);
});
