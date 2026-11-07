import { cn, Menu, type MenuItem, Row, Switch } from "@pipoca/ui";
import type { ReactElement, ReactNode } from "react";
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

// A row for an item from a layer below, with a switch that turns it off in
// the open layer.
export function InheritedRow<T>({
  entry,
  title,
  description,
  initials,
  owner,
  editable,
  menu = [],
  onToggle,
}: {
  readonly entry: Inherited<T>;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly initials?: string | undefined;
  // The open layer's name, such as Work.
  readonly owner: string;
  readonly editable: boolean;
  readonly menu?: readonly MenuItem[];
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
      {editable && menu.length > 0 && (
        <Menu label={`More for ${entry.key}`} items={menu} />
      )}
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
