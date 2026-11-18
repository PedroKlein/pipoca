import { ago } from "@pipoca/plugins/web";
import { Button, Icon, Mark } from "@pipoca/ui";
import type { ReactElement } from "react";
import type { ArtifactSummary, Version } from "../src/artifacts";

// Over a page, or alone in the window from a link.
export type Mode = "modal" | "window";

export const headings = { modal: "h2", window: "h1" } as const;

export const shellClass =
  "flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit] bg-elevated";

export const headerClass =
  "relative flex min-h-14 flex-wrap items-center gap-1.5 border-b border-line py-2.5 pr-3 pl-4.5";

// Alone in the window, the way back into Pipoca.
export function Lead({ mode }: { readonly mode: Mode }): ReactElement {
  return mode === "window" ? (
    <a href="#" aria-label="Pipoca home">
      <Mark className="size-8" />
    </a>
  ) : (
    <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-panel text-fg-dim">
      <Icon name="file-text" />
    </span>
  );
}

export function Title({
  mode,
  titleId,
  title,
  line,
}: {
  readonly mode: Mode;
  readonly titleId: string | undefined;
  readonly title: string;
  readonly line: string;
}): ReactElement {
  const Heading = headings[mode];

  return (
    <div className="ml-1.5 flex min-w-50 flex-1 flex-col max-sm:pr-8">
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

// Focused once the artifact is there, as the placeholder's was.
export function CloseButton({
  onClose,
}: {
  readonly onClose: () => void;
}): ReactElement {
  return (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      aria-label="Close"
      autoFocus
      onClick={onClose}
      className="max-sm:absolute max-sm:top-2.5 max-sm:right-3"
    >
      <Icon name="x" className="size-3.5" />
    </Button>
  );
}

// Who made a version, when, and what it changed. Pi's label is its own
// words, so it's quoted.
export function byline(version: Version, now: number): string {
  return [
    version.by,
    ago(new Date(version.createdAt).toISOString(), now),
    ...(version.note === ""
      ? []
      : [
          version.author.startsWith("session:")
            ? `“${version.note}”`
            : version.note,
        ]),
  ].join(" · ");
}

export function audienceLabel(artifact: ArtifactSummary): string {
  if (artifact.audience === "team") {
    return "Team";
  }

  if (artifact.audience === "named") {
    return `Shared with ${artifact.sharedWith.join(", ")}`;
  }

  return artifact.yours ? "Only you" : `From ${artifact.owner}`;
}
