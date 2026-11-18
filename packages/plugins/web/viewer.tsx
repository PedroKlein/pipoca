import { Button, buttonClass, Icon, Mark, Segmented } from "@pipoca/ui";
import { type ReactElement, useEffect, useEffectEvent, useState } from "react";
import {
  type PreviewKind,
  previewBytes,
  previewKind,
} from "../src/preview-kind";
import { Slot } from "./parts";

// Over a page, docked beside it, or alone in the window from a link.
export type ViewerMode = "modal" | "docked" | "window";

export const viewerHeadings = {
  modal: "h2",
  docked: "h2",
  window: "h1",
} as const;

export const viewerShellClass =
  "flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit] bg-elevated";

export const viewerHeaderClass =
  "relative flex min-h-14 flex-wrap items-center gap-1.5 border-b border-line py-2.5 pr-3 pl-4.5";

// Alone in the window, the way back into Pipoca. Docked or on a phone the
// title needs the room.
export function ViewerLead({
  mode,
}: {
  readonly mode: ViewerMode;
}): ReactElement | null {
  if (mode === "docked") {
    return null;
  }

  return mode === "window" ? (
    <a href="#" aria-label="Pipoca home">
      <Mark className="size-8" />
    </a>
  ) : (
    <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-panel text-fg-dim max-sm:hidden">
      <Icon name="file-text" />
    </span>
  );
}

export function ViewerTitle({
  mode,
  titleId,
  title,
  line,
}: {
  readonly mode: ViewerMode;
  readonly titleId: string | undefined;
  readonly title: string;
  readonly line: string;
}): ReactElement {
  const Heading = viewerHeadings[mode];

  return (
    <div className="ml-1.5 flex min-w-50 flex-1 flex-col max-sm:min-w-0">
      <Heading
        id={titleId}
        className="truncate text-[15px] font-semibold text-fg-strong"
      >
        {title}
      </Heading>
      <span className="truncate text-caption text-fg-dim">{line}</span>
    </div>
  );
}

// Focused when the viewer opens, unless something else in the header takes
// focus.
export function ViewerClose({
  onClose,
  focus = true,
}: {
  readonly onClose: () => void;
  readonly focus?: boolean;
}): ReactElement {
  return (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      aria-label="Close"
      autoFocus={focus}
      onClick={onClose}
      className="max-sm:order-first"
    >
      <Icon name="x" className="size-3.5" />
    </Button>
  );
}

export const frameSandbox =
  "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-forms";

const sources: Partial<Record<PreviewKind, readonly [string, string]>> = {
  csv: ["Table", "Raw"],
  markdown: ["Preview", "Source"],
  html: ["Preview", "Source"],
  svg: ["Picture", "Source"],
};

// A Session or Project file in the viewer: the page its preview route
// draws, or a download for what it can't show. Files have no versions,
// comments or sharing (ADR 0081).
export function FileViewer({
  name,
  line,
  size,
  view,
  download,
  titleId,
  session,
  stepper,
  note,
  onClose,
}: {
  readonly name: string;
  readonly line: string;
  readonly size: number;
  // The preview route, which takes as=text for the source.
  readonly view: string;
  readonly download: string;
  readonly titleId: string;
  // The Session it's kept for, when the person steers it, which plugins'
  // actions such as Publish act in.
  readonly session?: string;
  // Where it sits among its folder's files, which arrow keys step through.
  readonly stepper?: {
    readonly at: number;
    readonly of: number;
    readonly label: string;
    readonly step: (by: -1 | 1) => void;
  };
  readonly note?: string;
  readonly onClose: () => void;
}): ReactElement {
  const fileName = name.split("/").at(-1);
  const kind = size <= previewBytes ? previewKind(name) : undefined;
  const toggle = kind === undefined ? undefined : sources[kind];
  const [source, setSource] = useState(false);
  const steps = stepper !== undefined;

  const step = useEffectEvent((by: -1 | 1) => {
    stepper?.step(by);
  });

  useEffect(() => {
    if (!steps) {
      return undefined;
    }

    const press = (event: KeyboardEvent): void => {
      const target = event.target;

      const typing =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

      if (typing || event.altKey || event.metaKey || event.ctrlKey) {
        return;
      }

      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        step(event.key === "ArrowLeft" ? -1 : 1);
      }
    };

    addEventListener("keydown", press);

    return () => {
      removeEventListener("keydown", press);
    };
  }, [steps]);

  return (
    <div className={viewerShellClass}>
      <header className={viewerHeaderClass}>
        <ViewerLead mode="modal" />
        <ViewerTitle mode="modal" titleId={titleId} title={name} line={line} />
        {toggle !== undefined && (
          <Segmented
            label="Show"
            value={source ? "source" : "page"}
            options={[
              { value: "page", label: toggle[0] },
              { value: "source", label: toggle[1] },
            ]}
            onChange={(value) => {
              setSource(value === "source");
            }}
          />
        )}
        <a
          href={download}
          download={fileName}
          className={buttonClass({ size: "sm" })}
        >
          <Icon name="download" className="size-3.5" />
          Download
        </a>
        {session !== undefined && (
          <Slot
            name="file.actions"
            session={session}
            file={name}
            download={download}
          />
        )}
        <ViewerClose onClose={onClose} />
      </header>
      <div className="flex min-h-0 flex-1 flex-col bg-panel p-4 max-sm:p-0">
        {kind === undefined ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-line bg-elevated p-6 text-center max-sm:rounded-none max-sm:border-0">
            <Icon name="file" className="size-8 text-fg-dim" />
            <p className="max-w-sm text-label text-fg">
              {size > previewBytes
                ? "This file is too big to show here. Download it to open it."
                : `Pipoca can't preview ${extensionOf(name)} files. Download it to open it.`}
            </p>
            <a
              href={download}
              download={fileName}
              className={buttonClass({ variant: "primary", size: "sm" })}
            >
              Download
            </a>
          </div>
        ) : (
          <iframe
            key={`${view}:${String(source)}`}
            title={source ? `${name}, source` : name}
            src={source ? `${view}&as=text` : view}
            {...(kind !== "pdf" && { sandbox: frameSandbox })}
            className="min-h-0 w-full flex-1 rounded-lg border border-line bg-white max-sm:rounded-none max-sm:border-0"
          />
        )}
      </div>
      {(stepper !== undefined || note !== undefined) && (
        <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-2 text-caption text-fg-dim">
          {stepper !== undefined && (
            <span className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Previous file"
                title="Previous file (←)"
                aria-keyshortcuts="ArrowLeft"
                disabled={stepper.at <= 1}
                onClick={() => {
                  stepper.step(-1);
                }}
              >
                <Icon name="chevron-left" className="size-3.5" />
              </Button>
              <span aria-live="polite">
                {`${String(stepper.at)} of ${String(stepper.of)} ${stepper.label}`}
              </span>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Next file"
                title="Next file (→)"
                aria-keyshortcuts="ArrowRight"
                disabled={stepper.at >= stepper.of}
                onClick={() => {
                  stepper.step(1);
                }}
              >
                <Icon name="chevron-right" className="size-3.5" />
              </Button>
            </span>
          )}
          {note !== undefined && <span className="ml-auto">{note}</span>}
        </footer>
      )}
    </div>
  );
}

function extensionOf(name: string): string {
  const ext = name.includes(".") ? name.split(".").at(-1) : undefined;

  return ext === undefined || ext === "" ? "these" : `.${ext}`;
}
