import type { MountedSession } from "@pipoca/plugins/web";
import { cn, Icon } from "@pipoca/ui";
import { type ReactElement, type ReactNode, useState } from "react";
import { PluginBoundary } from "../../plugin-boundary";
import { fillsOf } from "../../plugins";
import { describeTool, linkParts, tally, type Turn, type Work } from "./chat";
import { Answer } from "./markdown";
import { StepRow } from "./step-row";
import { useVerbosity } from "./verbosity";

// What Pi did before its answer, folded to a line that says what it did.
export function WorkBlock({
  work,
  running,
  live,
  took,
}: {
  readonly work: readonly Work[];
  readonly running: readonly { readonly id: string; readonly name: string }[];
  readonly live: boolean;
  readonly took: string | undefined;
}): ReactElement {
  const steps = work.flatMap((item) =>
    item.kind === "step" ? [item.step] : [],
  );

  const failed = steps.filter((step) => step.result?.failed === true).length;
  const runningIds = new Set(running.map(({ id }) => id));

  const extra = running.filter(
    ({ id }) => !steps.some((step) => step.id === id),
  );

  const did = tally([...steps, ...extra]);
  const [verbosity] = useVerbosity();

  // Quiet shows only what runs now, so the turn reads as one line.
  const now = [...extra, ...steps.filter(({ id }) => runningIds.has(id))].at(
    -1,
  );

  const current =
    now === undefined
      ? undefined
      : describeTool(now.name, "args" in now ? now.args : undefined);

  const lastSaid = work.findLast(({ kind }) => kind === "said");
  const busy = steps.length + extra.length > 0;

  const verb = busy ? "worked" : "thought";
  const settled = took === undefined ? did : [`${verb} for ${took}`, ...did];

  return (
    <>
      <details
        open={verbosity === "verbose" || (verbosity === "normal" && live)}
        className="group/work"
      >
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md px-1 py-1 text-label text-fg-dim select-none hover:text-fg [&::-webkit-details-marker]:hidden">
          <Icon
            name="chevron-right"
            className="mr-0.5 size-3.5 transition-transform group-open/work:rotate-90"
          />
          {live ? (
            <span className="flex items-center gap-2 text-working">
              <span className="size-1.5 animate-pulse rounded-full bg-working" />
              Working
              {verbosity === "quiet" && current !== undefined && (
                <span className="truncate text-fg-dim">
                  · {current.verb} {current.object}
                </span>
              )}
            </span>
          ) : (
            <span className="font-medium text-fg">
              {sentence(settled[0] ?? verb)}
            </span>
          )}
          {(live ? did : settled.slice(1)).map((part) => (
            <span key={part}>· {part}</span>
          ))}
          {failed > 0 && <span className="text-failed">· {failed} failed</span>}
        </summary>
        <ol className="flex flex-col gap-px pt-1 pl-5">
          {work.map((item, index) => (
            <li
              key={
                item.kind === "step"
                  ? item.step.id
                  : `${item.kind}-${String(index)}`
              }
            >
              <WorkItem
                item={item}
                running={runningIds}
                verbosity={verbosity}
              />
            </li>
          ))}
          {extra.map(({ id, name }) => (
            <li key={id}>
              <StepRow
                step={{ id, name, args: undefined }}
                running
                open={verbosity === "verbose"}
              />
            </li>
          ))}
        </ol>
      </details>
      {live && verbosity === "quiet" && lastSaid?.kind === "said" && (
        <p className="truncate pl-6 text-label text-fg-dim">
          {oneLine(lastSaid.text)}
        </p>
      )}
    </>
  );
}

function WorkItem({
  item,
  running,
  verbosity,
}: {
  readonly item: Work;
  readonly running: ReadonlySet<string>;
  readonly verbosity: string;
}): ReactElement {
  switch (item.kind) {
    case "step":
      return (
        <StepRow
          step={item.step}
          running={running.has(item.step.id)}
          open={verbosity === "verbose"}
        />
      );
    case "said":
      return <SaidRow text={item.text} open={verbosity === "verbose"} />;
    case "thinking":
      return (
        <SaidRow
          label="Thought"
          text={item.text}
          open={verbosity === "verbose"}
        />
      );
    case "error":
    case "note":
      return <WorkNote kind={item.kind} text={item.text} />;
  }
}

export function Notice({
  notice: { text, tag },
  session,
}: {
  readonly notice: NonNullable<Turn["notice"]>;
  readonly session: MountedSession;
}): ReactElement {
  const Drawn = fillsOf(`notice:${tag.kind}`).find(
    ({ plugin }) => plugin === tag.plugin,
  )?.Component;

  return Drawn ? (
    <PluginBoundary name={tag.plugin}>
      <Drawn text={text} data={tag.data} session={session} />
    </PluginBoundary>
  ) : (
    <WorkNote kind="note" text={text} />
  );
}

// A notice with the ones about the same thing before it, which open under
// it on a click.
export function NoticeRun({
  notice,
  earlier,
  session,
}: {
  readonly notice: NonNullable<Turn["notice"]>;
  readonly earlier: readonly NonNullable<Turn["notice"]>[];
  readonly session: MountedSession;
}): ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col">
      <div className="flex min-w-0 items-center gap-2">
        <div className="peer min-w-0 flex-1">
          <Notice notice={notice} session={session} />
        </div>
        <button
          type="button"
          aria-expanded={open}
          className="flex shrink-0 peer-empty:hidden cursor-pointer items-center gap-1 text-caption text-fg-dim hover:text-fg"
          onClick={() => {
            setOpen(!open);
          }}
        >
          {`${String(earlier.length)} earlier`}
          <Icon
            name="chevron-down"
            className={cn("size-3 transition-transform", open && "rotate-180")}
          />
        </button>
      </div>
      {open && (
        <ol
          aria-label="Earlier updates"
          className="flex flex-col border-l border-line pl-3 opacity-80"
        >
          {[...earlier].reverse().map((each, at) => (
            <li key={String(at)}>
              <Notice notice={each} session={session} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function WorkNote({
  kind,
  text,
}: {
  readonly kind: "error" | "note";
  readonly text: string;
}): ReactElement {
  return (
    <p
      className={cn(
        "flex gap-2 px-2 py-1 text-label whitespace-pre-wrap",
        kind === "error" ? "text-failed" : "text-fg-dim",
      )}
    >
      {kind === "note" && (
        <Icon name="info" className="mt-0.5 size-4 shrink-0" />
      )}
      <span className="min-w-0 break-words">{linked(text)}</span>
    </p>
  );
}

// What Pi said or thought between tool calls, as one line that opens to all
// of it.
function SaidRow({
  label,
  text,
  open,
}: {
  readonly label?: string;
  readonly text: string;
  readonly open: boolean;
}): ReactElement {
  const [shown, setShown] = useState(open);

  return (
    <details
      open={open}
      onToggle={(event) => {
        setShown(event.currentTarget.open);
      }}
    >
      <summary
        className={cn(
          "flex min-w-0 cursor-pointer list-none gap-2 rounded-md px-2 py-1 text-label hover:bg-hover [&::-webkit-details-marker]:hidden",
          label === undefined ? "text-fg" : "text-fg-dim",
        )}
      >
        {label !== undefined && (
          <span className="shrink-0 font-medium text-fg">{label}</span>
        )}
        {shown ? (
          <div className="min-w-0">
            <Answer text={text} />
          </div>
        ) : (
          <span className="truncate">{oneLine(text)}</span>
        )}
      </summary>
    </details>
  );
}

function oneLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.replace(/[#>*_`|]/g, "").trim())
      .find((line) => line !== "") ?? ""
  );
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function linked(text: string): ReactNode[] {
  return linkParts(text).map((part, at) =>
    part.link ? (
      <a
        key={at}
        href={part.text}
        target="_blank"
        rel="noreferrer"
        className="text-fg underline"
      >
        {part.text}
      </a>
    ) : (
      part.text
    ),
  );
}
