import type { OpenedPage } from "@pipoca/protocol";
import { Button, Icon } from "@pipoca/ui";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { command } from "../data/client";
import { addressHref, navigate } from "../router";
import type { Feed } from "./feed";
import { pageLink } from "./page-link";

export function PagesNotice({
  sessionId,
  pages,
  report,
}: {
  readonly sessionId: string;
  readonly pages: readonly OpenedPage[];
  readonly report: (error: unknown) => void;
}): ReactElement | null {
  if (pages.length === 0) {
    return null;
  }

  return (
    <ul
      aria-label="Opened pages"
      className="mx-auto flex w-full max-w-chat flex-col gap-1 px-4 pb-2 text-label text-fg-dim"
    >
      {pages.map((page) => (
        <li key={page.id} className="flex items-center gap-3">
          <Icon name="external-link" />
          <span className="min-w-0 flex-1 truncate font-mono">
            {page.url.replace(/^https?:\/\//, "")}
          </span>
          <a
            href={pageLink(sessionId, page.url)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-control items-center rounded-md border border-line bg-elevated px-3 text-ui font-medium text-fg hover:border-line-strong hover:bg-hover pointer-coarse:min-h-touch"
          >
            Open
          </a>
          <Button
            variant="ghost"
            iconOnly
            aria-label="Dismiss"
            onClick={() => {
              command(sessionId, { type: "close_page", id: page.id }).catch(
                report,
              );
            }}
          >
            <Icon name="x" />
          </Button>
        </li>
      ))}
    </ul>
  );
}

// What a meta-session's tool opened (ADR 0035). A wide screen goes there at
// once; a phone offers it instead, so the chat stays where it is.
// What a meta-session's tool opened (ADR 0035). The main chat on a wide
// screen goes there at once; anywhere else it is offered instead, so the
// chat stays where it is. The region stays mounted so readers announce it.
export function UiActionNotice({
  uiAction,
  goes,
}: {
  readonly uiAction: Feed["uiAction"];
  readonly goes: boolean;
}): ReactElement {
  const [dismissed, setDismissed] = useState<number>();
  const handled = useRef<number>(undefined);
  const wide = goes && matchMedia("(width >= 48rem)").matches;

  useEffect(() => {
    if (uiAction === undefined || handled.current === uiAction.key) {
      return;
    }

    handled.current = uiAction.key;

    if (goes && matchMedia("(width >= 48rem)").matches) {
      navigate(addressHref(uiAction.action.route));
    }
  }, [uiAction, goes]);

  const offered =
    uiAction !== undefined && !wide && uiAction.key !== dismissed
      ? uiAction.action
      : undefined;

  return (
    <div role="status" className="mx-auto w-full max-w-chat px-4">
      {offered && (
        <div className="flex items-center gap-3 pb-2 text-label text-fg-dim">
          <span className="min-w-0 flex-1 truncate">Open {offered.label}?</span>
          <a
            href={addressHref(offered.route)}
            className="inline-flex h-control items-center rounded-md border border-line bg-elevated px-3 text-ui font-medium text-fg hover:border-line-strong hover:bg-hover pointer-coarse:min-h-touch"
          >
            Open
          </a>
          <Button
            variant="ghost"
            iconOnly
            aria-label="Dismiss"
            onClick={() => {
              setDismissed(uiAction?.key);
            }}
          >
            <Icon name="x" />
          </Button>
        </div>
      )}
    </div>
  );
}

export function PiViewNotice({
  piView: { attached, dialog },
  onOpen,
}: {
  readonly piView: Feed["piView"];
  readonly onOpen: () => void;
}): ReactElement | null {
  if (!attached && dialog === null) {
    return null;
  }

  return (
    <p
      role="status"
      className="mx-auto flex w-full max-w-chat items-center gap-3 px-4 pb-2 text-label text-fg-dim"
    >
      <span className="min-w-0 flex-1">
        {dialog === null
          ? "Pi is open in a Pi view, so extension dialogs show there."
          : `Pi is asking in the Pi view: ${dialog}`}
      </span>
      <Button variant="ghost" onClick={onOpen}>
        Open Pi view
      </Button>
    </p>
  );
}
