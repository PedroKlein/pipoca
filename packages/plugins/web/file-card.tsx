import { Icon } from "@pipoca/ui";
import type { ReactElement } from "react";

// A file Pi made, under its reply, which opens it in the viewer.
export function FileCard({
  title,
  detail,
  onOpen,
}: {
  readonly title: string;
  readonly detail: string;
  readonly onOpen: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      className="flex h-10 max-w-full min-w-0 cursor-pointer items-center gap-2 rounded-[10px] border border-line bg-elevated px-3 text-left hover:bg-hover focus-visible:ring-4 focus-visible:ring-focus focus-visible:outline-none"
      onClick={onOpen}
    >
      <Icon name="file" className="size-3.5 shrink-0 text-fg-dim" />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-label text-fg">{title}</span>
        <span className="truncate text-caption text-fg-dim">{detail}</span>
      </span>
    </button>
  );
}
