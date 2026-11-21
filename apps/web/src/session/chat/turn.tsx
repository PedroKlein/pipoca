import type { MountedSession } from "@pipoca/plugins/web";
import type { Quote } from "@pipoca/protocol";
import { cn } from "@pipoca/ui";
import type { ReactElement, ReactNode } from "react";
import { dataUrl } from "../composer/attachments";
import type { Feed } from "../feed";
import { ago } from "../../names";
import { duration, hasSteps, type Quoted, type Turn } from "./chat";
import { Answer } from "./markdown";
import { claimed, ToolCard } from "./tool-card";
import { Notice, WorkBlock, WorkNote } from "./work-block";

// What Pi said, its cards and its folded tool calls, in the order it made
// them. Tools still running belong to the turn's last work block.
function partItems(
  turn: Turn,
  running: Feed["tools"],
  live: boolean,
  took: string | undefined,
  session: MountedSession,
): ReactNode[] {
  const parts =
    running.length > 0 && turn.parts.at(-1)?.kind !== "work"
      ? [...turn.parts, { kind: "work", work: [] } as const]
      : turn.parts;

  const lastWork = parts.findLastIndex(({ kind }) => kind === "work");

  return parts.flatMap((part, at) => {
    const key = `${String(turn.key)}-${part.kind}-${String(at)}`;

    switch (part.kind) {
      case "said":
        return [
          <li
            key={key}
            data-role="assistant"
            className="[contain-intrinsic-size:auto_3rem] [content-visibility:auto]"
          >
            <Answer text={part.text} />
          </li>,
        ];
      case "card":
        return [
          <li key={key} data-role="card">
            <ToolCard step={part.step} session={session} />
          </li>,
        ];
      case "work": {
        const here = at === lastWork ? running : [];

        if (!hasSteps(part.work) && here.length === 0) {
          return part.work.map((item, index) =>
            item.kind === "error" || item.kind === "note" ? (
              <li key={`${key}-${String(index)}`} data-role={item.kind}>
                <WorkNote kind={item.kind} text={item.text} />
              </li>
            ) : null,
          );
        }

        return [
          <li key={key} data-role="work">
            <WorkBlock
              work={part.work}
              running={here}
              live={live && at === parts.length - 1}
              took={took}
            />
          </li>,
        ];
      }
    }
  });
}

// What one turn of the chat shows, as items of its list.
export function turnItems({
  turn,
  tools,
  first,
  last,
  live,
  now,
  session,
  onReply,
}: {
  readonly turn: Turn;
  readonly tools: Feed["tools"];
  readonly first: boolean;
  readonly last: boolean;
  readonly live: boolean;
  readonly now: number;
  readonly session: MountedSession;
  readonly onReply: ((quote: Quote) => void) | undefined;
}): ReactNode[] {
  const running = last ? tools.filter(({ name }) => !claimed(name)) : [];

  const folds = turn.parts.filter(
    (part) => part.kind === "work" && hasSteps(part.work),
  ).length;

  const took =
    turn.started !== undefined && turn.ended !== undefined && !(last && live)
      ? duration(turn.started, turn.ended)
      : undefined;

  return [
    !first && turn.user !== undefined && (
      <li
        key={`${String(turn.key)}-rule`}
        aria-hidden
        className="border-t border-line"
      />
    ),
    turn.by !== undefined && (
      <li
        key={`${String(turn.key)}-by`}
        data-role="author"
        className="-mb-4 self-end text-caption text-fg-dim"
      >
        {turn.by}
      </li>
    ),
    turn.user !== undefined && (
      <li
        key={`${String(turn.key)}-user`}
        data-role="user"
        className="max-w-[85%] self-end rounded-xl rounded-br-sm bg-elevated px-4 py-2.5 text-prose whitespace-pre-wrap text-fg-strong shadow-card [contain-intrinsic-size:auto_3rem] [content-visibility:auto]"
      >
        {turn.images && (
          <span className="mb-2 flex flex-wrap justify-end gap-2">
            {turn.images.map((image, at) => (
              <img
                key={`${String(at)}-${image.data.slice(-16)}`}
                src={dataUrl(image)}
                alt={`Image ${String(at + 1)} sent with this message`}
                className="max-h-48 max-w-full rounded-md border border-line object-contain"
              />
            ))}
          </span>
        )}
        {turn.quote && <QuoteLine quote={turn.quote} />}
        {turn.user}
      </li>
    ),
    turn.user !== undefined && onReply && (
      <li key={`${String(turn.key)}-reply`} className="-mt-4 self-end">
        <ReplyButton
          onClick={() => {
            onReply({ from: turn.from ?? "", text: turn.user ?? "" });
          }}
        />
      </li>
    ),
    turn.team && (
      <TeamMessage
        key={`${String(turn.key)}-team`}
        said={turn.team}
        onReply={onReply}
      />
    ),
    turn.notice && (
      <li
        key={`${String(turn.key)}-notice`}
        data-role="notice"
        className="empty:hidden"
      >
        <Notice notice={turn.notice} session={session} />
      </li>
    ),
    ...partItems(
      turn,
      running,
      last && live,
      folds === 1 ? took : undefined,
      session,
    ),
    ...turn.answer.map((text, at) => (
      <li
        key={`${String(turn.key)}-answer-${String(at)}`}
        data-role="assistant"
        className="[contain-intrinsic-size:auto_3rem] [content-visibility:auto]"
      >
        <Answer text={text} />
      </li>
    )),
    turn.answer.length > 0 && !(last && live) && (
      <AnswerMeta
        key={`${String(turn.key)}-meta`}
        turn={turn}
        now={now}
        took={folds > 1 ? took : undefined}
        {...(onReply && {
          onReply: () => {
            onReply({ from: "pi", text: turn.answer.join("\n\n") });
          },
        })}
      />
    ),
  ];
}

function AnswerMeta({
  turn,
  now,
  took,
  onReply,
}: {
  readonly turn: Turn;
  readonly now: number;
  readonly took: string | undefined;
  readonly onReply?: () => void;
}): ReactElement | null {
  if (
    turn.ended === undefined &&
    turn.model === undefined &&
    onReply === undefined
  ) {
    return null;
  }

  return (
    <li
      data-role="answer-meta"
      className="-mt-2 flex gap-3 text-caption text-fg-dim"
    >
      {took !== undefined && <span>Worked for {took}</span>}
      {turn.ended !== undefined && (
        <time
          dateTime={turn.ended}
          title={new Date(turn.ended).toLocaleString()}
        >
          {ago(turn.ended, now)}
        </time>
      )}
      {turn.model !== undefined && <span>{turn.model}</span>}
      {onReply && <ReplyButton onClick={onReply} />}
    </li>
  );
}

function ReplyButton({
  className,
  onClick,
}: {
  readonly className?: string;
  readonly onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "cursor-pointer text-caption text-fg-dim hover:text-fg",
        className,
      )}
    >
      Reply
    </button>
  );
}

function QuoteLine({ quote }: { readonly quote: Quoted }): ReactElement {
  return (
    <span className="mb-1.5 block border-l-2 border-line-strong pl-2 text-label text-fg-dim">
      <span className="font-medium">{quote.by}</span>{" "}
      <span className="line-clamp-2">{quote.text}</span>
    </span>
  );
}

// People talking to each other in a team Session, which Pi doesn't answer.
function TeamMessage({
  said,
  onReply,
}: {
  readonly said: NonNullable<Turn["team"]>;
  readonly onReply: ((quote: Quote) => void) | undefined;
}): ReactElement {
  return (
    <li data-role="team" className="flex max-w-[85%] flex-col gap-1 self-start">
      <span className="text-caption text-fg-dim">
        {said.by} · {said.aside ? "off the record" : "to the team"}
      </span>
      <span
        className={cn(
          "rounded-xl rounded-bl-sm px-4 py-2.5 text-prose whitespace-pre-wrap text-fg-strong",
          said.aside
            ? "border border-dashed border-line-strong"
            : "bg-elevated shadow-card",
        )}
      >
        {said.quote && <QuoteLine quote={said.quote} />}
        {said.text}
      </span>
      <span className="flex gap-3 text-caption text-fg-dim">
        {said.aside
          ? "Hidden from Pi, visible to the team"
          : "Pi didn't answer"}
        {onReply && (
          <button
            type="button"
            onClick={() => {
              onReply({ from: said.from, text: said.text });
            }}
            className="cursor-pointer hover:text-fg"
          >
            Reply
          </button>
        )}
      </span>
    </li>
  );
}
