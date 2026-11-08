import type { MountedSession } from "@pipoca/plugins/web";
import type { Quote } from "@pipoca/protocol";
import { cn } from "@pipoca/ui";
import type { ReactElement, ReactNode } from "react";
import { dataUrl } from "../composer/attachments";
import type { Feed } from "../feed";
import { ago } from "../../names";
import { hasSteps, type Quoted, type Turn } from "./chat";
import { Answer } from "./markdown";
import { claimed, ToolCard } from "./tool-card";
import { Notice, WorkBlock, WorkNote } from "./work-block";

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
        className="max-w-[85%] self-end rounded-xl rounded-br-sm bg-elevated px-4 py-2.5 text-prose whitespace-pre-wrap text-fg-strong shadow-card [content-visibility:auto]"
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
      <li key={`${String(turn.key)}-notice`} data-role="notice">
        <Notice notice={turn.notice} />
      </li>
    ),
    hasSteps(turn.work) || running.length > 0 ? (
      <li key={`${String(turn.key)}-work`} data-role="work">
        <WorkBlock turn={turn} running={running} live={last && live} />
      </li>
    ) : (
      turn.work.map((item, at) =>
        item.kind === "step" ? null : (
          <li
            key={`${String(turn.key)}-note-${String(at)}`}
            data-role={item.kind}
          >
            <WorkNote kind={item.kind} text={item.text} />
          </li>
        ),
      )
    ),
    ...turn.cards.flatMap((step) => [
      step.lead !== undefined && (
        <li
          key={`${String(turn.key)}-lead-${step.id}`}
          data-role="assistant"
          className="[content-visibility:auto]"
        >
          <Answer text={step.lead} />
        </li>
      ),
      <li key={`${String(turn.key)}-card-${step.id}`} data-role="card">
        <ToolCard step={step} session={session} />
      </li>,
    ]),
    ...turn.answer.map((text, at) => (
      <li
        key={`${String(turn.key)}-answer-${String(at)}`}
        data-role="assistant"
        className="[content-visibility:auto]"
      >
        <Answer text={text} />
      </li>
    )),
    turn.answer.length > 0 && !(last && live) && (
      <AnswerMeta
        key={`${String(turn.key)}-meta`}
        turn={turn}
        now={now}
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
  onReply,
}: {
  readonly turn: Turn;
  readonly now: number;
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
