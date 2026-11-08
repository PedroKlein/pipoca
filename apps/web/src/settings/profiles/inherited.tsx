import { cn, Menu, type MenuItem, Row, Switch } from "@pipoca/ui";
import type { ReactElement, ReactNode } from "react";
import { navigate } from "../../router";
import type { Inherited, StackLayer } from "./stack";

const marks: Readonly<Record<StackLayer["kind"] | "own", string>> = {
  base: "bg-butter",
  defaults: "bg-working",
  profile: "bg-waiting",
  own: "bg-done",
};

// Where an item comes from: the Server base, My defaults, a Profile below or
// the one open.
export function SourceTag({
  name,
  kind,
}: {
  readonly name: string;
  readonly kind: StackLayer["kind"] | "own";
}): ReactElement {
  return (
    <span className="inline-flex h-5.5 shrink-0 items-center gap-1.5 rounded-md border border-line bg-elevated px-2 font-sans text-caption font-medium text-fg">
      <span
        aria-hidden="true"
        className={cn("size-2 rounded-xs", marks[kind])}
      />
      {name}
    </span>
  );
}

// What the menu on an inherited item offers: the switch's action, copying
// it into the open layer where that's possible, and its own layer's page.
export function inheritedMenu<T>({
  entry,
  owner,
  editable,
  onToggle,
  onCopy,
}: {
  readonly entry: Inherited<T>;
  readonly owner: string;
  readonly editable: boolean;
  readonly onToggle: (key: string, on: boolean) => void;
  readonly onCopy?: () => void;
}): readonly MenuItem[] {
  return [
    ...(editable
      ? [
          {
            label: entry.off
              ? `Turn back on in ${owner}`
              : `Turn off in ${owner}`,
            description: "Same as the switch",
            run: () => {
              onToggle(entry.key, entry.off);
            },
          },
        ]
      : []),
    ...(editable && onCopy
      ? [
          {
            label: `Copy into ${owner} to change it`,
            description: `${owner}'s copy replaces the ${entry.from.name}'s`,
            run: onCopy,
          },
        ]
      : []),
    {
      label: `View in ${entry.from.name}`,
      ...(entry.from.kind === "base" && {
        description: "Read-only unless you're an admin",
      }),
      run: () => {
        navigate(entry.from.href);
      },
    },
  ];
}

// A row for an item from a layer below, with a switch that turns it off in
// the open layer.
export function InheritedRow<T>({
  entry,
  title,
  description,
  initials,
  owner,
  editable,
  onToggle,
}: {
  readonly entry: Inherited<T>;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly initials?: string | undefined;
  // The open layer's name, such as Work.
  readonly owner: string;
  readonly editable: boolean;
  readonly onToggle: (key: string, on: boolean) => void;
}): ReactElement {
  return (
    <Row
      {...(initials !== undefined && { initials })}
      title={title}
      description={entry.off ? `Off in ${owner}` : description}
      className={cn("bg-panel", entry.off && "opacity-60")}
    >
      <SourceTag name={entry.from.name} kind={entry.from.kind} />
      <Menu
        label={`More for ${entry.key}`}
        items={inheritedMenu({ entry, owner, editable, onToggle })}
      />
      <Switch
        label={`${entry.key} in ${owner}`}
        labelHidden
        checked={!entry.off}
        disabled={!editable}
        onChange={(on) => {
          onToggle(entry.key, on);
        }}
      />
    </Row>
  );
}

// The first line worth showing of a text, such as an AGENTS.md heading.
export function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find((line) => line !== "") ?? ""
  );
}

// A text's line after its first, cut short, and how long it is.
export function summaryOf(text: string): string {
  const lines = text.trim().split("\n");

  const next =
    lines
      .slice(1)
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find((line) => line !== "") ?? "";

  const count = `${String(lines.length)} ${lines.length === 1 ? "line" : "lines"}`;

  return next === ""
    ? count
    : `${next.length > 60 ? `${next.slice(0, 60)}…` : next} · ${count}`;
}
