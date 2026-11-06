import { cn, Icon } from "@pipoca/ui";
import type { ReactElement, ReactNode } from "react";
import { PluginBoundary } from "../../plugin-boundary";
import { enabledPlugins } from "../../plugins";
import { describeTool, duration, linkParts, tally, type Turn } from "./chat";
import { StepRow } from "./step-row";
import { useVerbosity } from "./verbosity";

export function WorkBlock({
  turn,
  running,
  live,
}: {
  readonly turn: Turn;
  readonly running: readonly { readonly id: string; readonly name: string }[];
  readonly live: boolean;
}): ReactElement {
  const { work, started, ended } = turn;

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

  return (
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
            {started !== undefined && ended !== undefined
              ? `Worked for ${duration(started, ended)}`
              : "Worked"}
          </span>
        )}
        {did.map((part) => (
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
            {item.kind === "step" ? (
              <StepRow
                step={item.step}
                running={runningIds.has(item.step.id)}
                open={verbosity === "verbose"}
              />
            ) : (
              <WorkNote kind={item.kind} text={item.text} />
            )}
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
  );
}

export function Notice({
  notice: { text, tag },
}: {
  readonly notice: NonNullable<Turn["notice"]>;
}): ReactElement {
  const Drawn = enabledPlugins().find(({ name }) => name === tag.plugin)
    ?.notices[tag.kind];

  return Drawn ? (
    <PluginBoundary name={tag.plugin}>
      <Drawn text={text} data={tag.data} />
    </PluginBoundary>
  ) : (
    <WorkNote kind="note" text={text} />
  );
}

export function WorkNote({
  kind,
  text,
}: {
  readonly kind: "narration" | "error" | "note";
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
