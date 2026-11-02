import type { SessionPartProps, WebPlugin } from "@pipoca/plugins/web";
import { cn, Icon } from "@pipoca/ui";
import { type ReactElement, useEffect, useId, useState } from "react";
import { isOpen, type Item, listOf, toolName } from "../src/list";

// The agent's checklist, pinned above the composer while it has open items
// (ADR 0056). Its calls show nowhere else.
export const checklist: WebPlugin = {
  name: "checklist",
  Composer: PinnedList,
  tools: { [toolName]: () => null },
};

function PinnedList({ session }: SessionPartProps): ReactElement | null {
  const items = useList(session);
  const [open, setOpen] = useState(false);
  const listId = useId();

  if (!isOpen(items)) {
    return null;
  }

  const done = items.filter(({ status }) => status === "completed").length;

  const current =
    items.find(({ status }) => status === "in_progress") ??
    items.find(({ status }) => status === "pending");

  return (
    <section
      aria-label="Checklist"
      className="flex flex-col gap-1.5 rounded-lg border border-line bg-panel px-3 py-2"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          setOpen(!open);
        }}
        className="flex min-w-0 cursor-pointer items-center gap-2 text-left text-label"
      >
        {current && <Mark status={current.status} />}
        <span className="min-w-0 flex-1 truncate text-fg">{current?.text}</span>
        <span className="shrink-0 text-fg-dim">
          {String(done)} of {String(items.length)}
        </span>
        <Icon
          name="chevron-down"
          className={cn("size-4 shrink-0 text-fg-dim", open && "rotate-180")}
        />
      </button>
      {open && (
        <ol id={listId} className="flex flex-col gap-1">
          {items.map((item, at) => (
            <li
              key={at}
              className={cn(
                "flex min-w-0 items-start gap-2 text-label",
                item.status === "completed" ? "text-fg-dim" : "text-fg",
              )}
            >
              <Mark status={item.status} />
              <span className="min-w-0 break-words">{item.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function useList(session: SessionPartProps["session"]): readonly Item[] {
  const [items, setItems] = useState<readonly Item[]>([]);

  useEffect(
    () =>
      session.events((event) => {
        const found = event.type === "entry" ? listOf(event.entry) : undefined;

        if (found) {
          setItems(found);
        }
      }),
    [session],
  );

  return items;
}

function Mark({ status }: { readonly status: Item["status"] }): ReactElement {
  switch (status) {
    case "completed":
      return (
        <span aria-label="Done" className="shrink-0">
          <Icon name="check" className="size-4 text-done" />
        </span>
      );
    case "in_progress":
      return (
        <span
          aria-label="In progress"
          className="grid size-4 shrink-0 place-items-center"
        >
          <span className="size-1.5 animate-pulse rounded-full bg-working" />
        </span>
      );
    case "pending":
      return (
        <span
          aria-label="Not started"
          className="grid size-4 shrink-0 place-items-center"
        >
          <span className="size-2.5 rounded-full border border-line-strong" />
        </span>
      );
  }
}
