import { Avatar, Badge, Button, cn, Icon, Menu } from "@pipoca/ui";
import type { ReactElement } from "react";
import type {
  Doc,
  DocStatus,
  DocType,
  Reviewer,
  Verdict,
} from "../src/artifacts";
import type { Thread } from "./comments";

const typeLabels: Readonly<Record<DocType, string>> = {
  design: "Design doc",
  spec: "Spec",
  plan: "Plan",
};

const statusLabels: Readonly<Record<DocStatus, string>> = {
  draft: "Draft",
  review: "In review",
  decided: "Decided",
};

const statusLooks: Readonly<Record<DocStatus, string>> = {
  draft: "bg-hover text-fg-dim",
  review: "bg-working-tint text-working",
  decided: "bg-done-tint text-done",
};

export function docLabel(doc: Doc): string {
  return typeLabels[doc.type];
}

// The headings of the page, and which pinned threads sit under each.
export interface Outline {
  readonly sections: readonly {
    readonly text: string;
    readonly level: number;
    readonly threads: readonly number[];
  }[];
  // Where each pinned thread sits, from the top of the page.
  readonly tops: readonly { readonly n: number; readonly top: number }[];
  // How far the page was scrolled then.
  readonly scrolled: number;
}

// The status as a pill, which whoever steers the doc changes.
export function DocStatusPill({
  doc,
  steers,
  onStatus,
}: {
  readonly doc: Doc;
  readonly steers: boolean;
  readonly onStatus: (status: DocStatus) => void;
}): ReactElement {
  const label = statusLabels[doc.status];
  const look = cn(
    "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-caption font-medium whitespace-nowrap before:size-1.5 before:rounded-full before:bg-current",
    statusLooks[doc.status],
  );

  if (!steers) {
    return (
      <span aria-label={`Status: ${label}`} className={look}>
        {label}
      </span>
    );
  }

  return (
    <Menu
      label={`Status: ${label}`}
      size="sm"
      align="end"
      heading="Status"
      triggerClassName={look}
      trigger={
        <>
          {label}
          <Icon name="chevron-down" className="size-3" />
        </>
      }
      items={(Object.keys(statusLabels) as DocStatus[]).map((status) => ({
        label: statusLabels[status],
        checked: status === doc.status,
        run: () => {
          onStatus(status);
        },
      }))}
    />
  );
}

const verdictLabels: Readonly<Record<Verdict, string>> = {
  approved: "Approved",
  changes: "Changes asked",
};

// Who reviews the doc and what they said, the open questions, and the
// viewer's own verdict when they review it.
export function ReviewBar({
  doc,
  threads,
  people,
  steers,
  onReviewers,
  onVerdict,
}: {
  readonly doc: Doc;
  readonly threads: readonly Thread[];
  // Everyone else who can see it, who can be asked to review.
  readonly people: readonly string[];
  readonly steers: boolean;
  readonly onReviewers: (names: readonly string[]) => void;
  readonly onVerdict: (verdict: Verdict) => void;
}): ReactElement {
  const names = doc.reviewers.map(({ name }) => name);
  const asked = people.filter((name) => !names.includes(name));
  const mine = doc.reviewers.find(({ you }) => you);
  const asks = threads.filter(({ top }) => top.kind === "question");
  const open = asks.filter(({ top }) => !top.resolved).length;

  return (
    <section
      aria-label="Review"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-4.5 py-2"
    >
      <h3 className="text-label font-medium text-fg-strong">Review</h3>
      <ul className="flex flex-wrap items-center gap-3">
        {doc.reviewers.map((reviewer) => (
          <ReviewerChip
            key={reviewer.name}
            reviewer={reviewer}
            {...(steers && {
              onRemove: () => {
                onReviewers(names.filter((name) => name !== reviewer.name));
              },
            })}
          />
        ))}
      </ul>
      {steers && asked.length > 0 && (
        <Menu
          label="Add reviewer"
          size="sm"
          heading="Ask to review"
          trigger={
            <>
              <Icon name="plus" className="size-3.5" />
              {doc.reviewers.length === 0 && "Ask for review"}
            </>
          }
          items={asked.map((name) => ({
            label: name,
            mark: <Avatar name={name} size="xs" />,
            run: () => {
              onReviewers([...names, name]);
            },
          }))}
        />
      )}
      <span className="ml-auto text-caption text-fg-dim">
        {open === 1 ? "1 open question" : `${String(open)} open questions`} ·{" "}
        {asks.length - open} resolved
      </span>
      {mine !== undefined && (
        <span className="flex gap-1.5">
          <Button
            size="sm"
            aria-pressed={mine.verdict === "approved"}
            className="aria-pressed:bg-done-tint aria-pressed:text-done"
            onClick={() => {
              onVerdict("approved");
            }}
          >
            Approve
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={mine.verdict === "changes"}
            className="aria-pressed:bg-waiting-tint aria-pressed:text-waiting"
            onClick={() => {
              onVerdict("changes");
            }}
          >
            Ask for changes
          </Button>
        </span>
      )}
    </section>
  );
}

function ReviewerChip({
  reviewer,
  onRemove,
}: {
  readonly reviewer: Reviewer;
  readonly onRemove?: () => void;
}): ReactElement {
  const shown = reviewer.you ? "You" : reviewer.name;

  return (
    <li className="group flex items-center gap-1.5 text-label text-fg">
      <Avatar name={reviewer.name} size="xs" />
      {shown}
      {reviewer.verdict === null ? (
        <Badge>Not yet</Badge>
      ) : (
        <Badge state={reviewer.verdict === "approved" ? "done" : "waiting"}>
          {verdictLabels[reviewer.verdict]}
        </Badge>
      )}
      {onRemove !== undefined && (
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label={`Take ${reviewer.name} off the review`}
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={onRemove}
        >
          <Icon name="x" className="size-3" />
        </Button>
      )}
    </li>
  );
}

// The doc's sections, each with its open threads, and its open questions.
export function OutlineNav({
  outline,
  threads,
  onSection,
  onQuestions,
}: {
  readonly outline: Outline | undefined;
  readonly threads: readonly Thread[];
  readonly onSection: (index: number) => void;
  readonly onQuestions: () => void;
}): ReactElement {
  const all = outline?.sections ?? [];

  // A lone first-level heading is the doc's title, not a section.
  const titled =
    all.filter(({ level }) => level === 1).length === 1 && all[0]?.level === 1;

  const sections = all.flatMap((section, index) =>
    titled && index === 0 ? [] : [{ ...section, index }],
  );

  const top = Math.min(...sections.map(({ level }) => level));
  const questions = threads.filter(
    ({ top: each }) => each.kind === "question" && !each.resolved,
  ).length;

  const row =
    "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-label text-fg hover:bg-hover";

  return (
    <nav
      aria-label="Outline"
      className="flex w-50 shrink-0 flex-col gap-1 overflow-y-auto border-r border-line bg-elevated p-3 max-lg:hidden"
    >
      <h3 className="px-2 pb-1 text-label font-medium text-fg-strong">
        Outline
      </h3>
      <ul className="flex flex-col">
        {sections.map(({ text, level, threads: on, index }) => (
          <li key={index}>
            <button
              type="button"
              className={row}
              style={{
                paddingLeft: `${String(0.5 + (level - top) * 0.75)}rem`,
              }}
              onClick={() => {
                onSection(index);
              }}
            >
              <span className="min-w-0 flex-1 truncate">{text}</span>
              {on.length > 0 && <Count n={on.length} />}
            </button>
          </li>
        ))}
        <li>
          <button type="button" className={row} onClick={onQuestions}>
            <span className="min-w-0 flex-1 truncate">Open questions</span>
            {questions > 0 && <Count n={questions} />}
          </button>
        </li>
      </ul>
    </nav>
  );
}

function Count({ n }: { readonly n: number }): ReactElement {
  return (
    <span className="grid h-5 min-w-5 place-items-center rounded-md bg-butter/40 px-1 text-caption text-fg-strong">
      {n}
      <span className="sr-only"> open</span>
    </span>
  );
}
