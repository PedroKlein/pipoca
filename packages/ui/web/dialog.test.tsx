import { expect, test } from "bun:test";
import { act, type ReactElement, useState } from "react";
import { Dialog, useConfirm } from "./dialog";
import { byRole, click, render, withPage } from "./testing/render";

withPage();

test("a dialog shows its content only while open, named by its title", () => {
  const closed: string[] = [];

  const page = render(
    <>
      <Dialog
        open
        title="Invite people"
        onClose={() => {
          closed.push("closed");
        }}
      >
        <p>Body</p>
      </Dialog>
      <Dialog open={false} title="Hidden" onClose={() => undefined}>
        <p>Never</p>
      </Dialog>
    </>,
  );

  const dialog = byRole(page, "dialog", "Invite people");

  expect(dialog.textContent).toContain("Body");
  expect(page.textContent).not.toContain("Never");

  click(byRole(dialog, "button", "Close"));

  expect(closed.length).toBeGreaterThan(0);
});

test("a dialog opened from another closes only itself", () => {
  const closed: string[] = [];

  const page = render(
    <Dialog open title="Viewer" onClose={() => closed.push("viewer")}>
      <Dialog open title="Share" onClose={() => closed.push("share")}>
        <p>People</p>
      </Dialog>
    </Dialog>,
  );

  act(() => {
    byRole(page, "dialog", "Share").dispatchEvent(new Event("close"));
  });

  expect(closed).toContain("share");
  expect(closed).not.toContain("viewer");
});

function Opener(): ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
        }}
      >
        Open
      </button>
      {open && (
        <Dialog open title="Viewer" onClose={() => undefined}>
          <button type="button">Inside</button>
        </Dialog>
      )}
    </>
  );
}

test("focus goes back to what opened a dialog, even when it leaves without closing", () => {
  const page = render(<Opener />);
  const opener = byRole(page, "button", "Open");

  opener.focus();
  click(opener);
  byRole(page, "button", "Inside").focus();

  act(() => {
    opener.click();
  });

  expect(document.activeElement).toBe(opener);
});

function Asking({ answers }: { readonly answers: boolean[] }): ReactElement {
  const [confirm, dialog] = useConfirm();
  const [asked, setAsked] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setAsked(true);

          void confirm({
            title: "Delete the routine?",
            confirm: "Delete",
            danger: true,
          }).then((yes) => {
            answers.push(yes);
          });
        }}
      >
        {asked ? "Asked" : "Ask"}
      </button>
      {dialog}
    </>
  );
}

test("confirm resolves with the person's answer", async () => {
  const answers: boolean[] = [];
  const page = render(<Asking answers={answers} />);

  click(byRole(page, "button", "Ask"));

  click(
    byRole(byRole(page, "dialog", "Delete the routine?"), "button", "Delete"),
  );

  await act(async () => Promise.resolve());

  click(byRole(page, "button", "Asked"));
  click(byRole(page, "button", "Cancel"));
  await act(async () => Promise.resolve());

  expect(answers).toEqual([true, false]);
  expect(page.textContent).not.toContain("Delete the routine?");
});

test("a confirm asked again before the last one's close arrives stays open", async () => {
  const answers: boolean[] = [];
  const page = render(<Asking answers={answers} />);

  click(byRole(page, "button", "Ask"));

  const dialog = byRole(page, "dialog", "Delete the routine?");

  dialog.removeAttribute("open");
  click(byRole(page, "button", "Asked"));

  act(() => {
    dialog.dispatchEvent(new Event("close"));
  });

  await act(async () => Promise.resolve());

  expect(answers).toEqual([]);

  expect(byRole(page, "dialog", "Delete the routine?").textContent).toContain(
    "Delete",
  );
});
