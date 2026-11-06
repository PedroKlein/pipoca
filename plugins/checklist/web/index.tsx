import {
  defineWeb,
  Hidden,
  type MountedSession,
  useToolResults,
} from "@pipoca/plugins/web";
import { cn, Icon, type MarkStatus, StatusMark } from "@pipoca/ui";
import { type ReactElement, useId, useState } from "react";
import { checklist } from "../plugin";
import { type Item, toolName } from "../src/items";

// The agent's checklist, pinned above the composer while it has open items
// (ADR 0056). Its calls show nowhere else.
export const web = defineWeb(checklist, {
  slots: {
    "session.composer": PinnedList,
    [`session.toolCall:${toolName}`]: Hidden,
  },
});

function PinnedList({
  session,
}: {
  readonly session: MountedSession;
}): ReactElement | null {
  const items =
    useToolResults<{ readonly items?: readonly Item[] }>(session, toolName)
      .filter(({ isError }) => !isError)
      .at(-1)?.details.items ?? [];

  const [open, setOpen] = useState(false);
  const listId = useId();
  const done = items.filter(({ status }) => status === "completed").length;

  if (done === items.length) {
    return null;
  }

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

const marks = {
  completed: ["done", "Done"],
  in_progress: ["running", "In progress"],
  pending: ["pending", "Not started"],
} as const satisfies Record<Item["status"], readonly [MarkStatus, string]>;

function Mark({ status }: { readonly status: Item["status"] }): ReactElement {
  const [mark, label] = marks[status];

  return <StatusMark status={mark} label={label} />;
}
