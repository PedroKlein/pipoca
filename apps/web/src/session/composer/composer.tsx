import { type ModelRef, type Quote, teamTalkSince } from "@pipoca/protocol";
import type { MountedSession } from "@pipoca/plugins/web";
import { Button, Icon, isComposing } from "@pipoca/ui";
import { type ReactElement, useEffect, useId, useRef, useState } from "react";
import { command } from "../../data/client";
import { usePrimaryId } from "../../primary";
import type { Feed } from "../feed";
import { PromptCard, type PromptHandlers } from "../questions/prompt-card";
import {
  Styled,
  TerminalColumns,
  TerminalText,
} from "../terminal/terminal-text";
import { AttachedImages } from "./attached-images";
import { usePrefill } from "./prefill";
import { Queued } from "./queued";
import { useSend } from "./send";
import { useSuggestions } from "./suggestions";
import { placeholders, type Target } from "./target";
import { TeamTalk } from "./team-talk";
import { Toolbar } from "./toolbar";
import { PluginParts, Widgets } from "./widgets";

// A reply in team work, and the name of whoever it answers.
export interface Replying {
  readonly quote: Quote;
  readonly by: string;
}

export function Composer({
  sessionId,
  session,
  feed,
  models,
  hiddenModels,
  hidden,
  report,
  team = false,
  replying,
  onReplied,
  onFork,
}: {
  readonly sessionId: string;
  readonly session: MountedSession;
  readonly feed: Feed;
  readonly models: readonly ModelRef[];
  readonly hiddenModels: readonly string[];
  readonly hidden: boolean;
  readonly report: (error: unknown) => void;
  // Team work's composer also talks to people (ADR 0065).
  readonly team?: boolean;
  readonly replying?: Replying | undefined;
  readonly onReplied?: () => void;
  // Starts a fork whose composer holds what was typed here.
  readonly onFork?: (draft: string) => void;
}): ReactElement {
  const [target, setTarget] = useState<Target>("pi");
  const text = useRef<HTMLTextAreaElement>(null);
  const promptId = usePrimaryId("prompt");
  const generatedId = useId();
  const textId = usePrimaryId("prompt-text") ?? generatedId;
  const modelMenu = useRef<HTMLButtonElement>(null);
  const suggestions = useSuggestions(feed);
  const running = feed.session?.status === "running";
  const { steering, followUp } = feed.queue;
  const [columns, setColumns] = useState<number>();
  const generation = feed.session?.generation;
  const hosted = feed.session?.status === "idle" || running;

  useEffect(() => {
    if (columns === undefined || !hosted) {
      return;
    }

    const later = setTimeout(() => {
      // Only a running Session can hear it, and each start is told again.
      command(sessionId, { type: "ui_columns", columns }).catch(
        () => undefined,
      );
    }, 200);

    return () => {
      clearTimeout(later);
    };
  }, [sessionId, columns, generation, hosted]);

  usePrefill(sessionId, text, feed.editorText);

  const { images, setImages, attach, send } = useSend({
    sessionId,
    feed,
    team,
    target,
    replying,
    onReplied,
    report,
    textRef: text,
    modelMenuRef: modelMenu,
  });

  const handlers: PromptHandlers = {
    answer: (id, value) => {
      command(sessionId, { type: "answer", id, value }).catch(report);
    },
    explain: (id, questionId, value, question) => {
      command(sessionId, {
        type: "explain",
        id,
        questionId,
        value,
        question,
      }).catch(report);
    },
  };

  return (
    <div className="mx-auto flex w-full max-w-chat flex-col gap-2 px-4 pb-4">
      {feed.prompts.map((open) => (
        <PromptCard key={open.prompt.id} open={open} handlers={handlers} />
      ))}

      <Queued
        sessionId={sessionId}
        steering={steering}
        followUp={followUp}
        report={report}
      />

      <TerminalColumns onColumns={setColumns} />

      <PluginParts session={session} team={team} />

      <Widgets widgets={feed.widgetsAbove} />

      {!hidden && (
        <form
          id={promptId}
          onSubmit={(event) => {
            event.preventDefault();
            send("followUp");
          }}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) {
              event.preventDefault();
            }
          }}
          onDrop={(event) => {
            if (event.dataTransfer.files.length > 0) {
              event.preventDefault();
              attach([...event.dataTransfer.files]);
            }
          }}
          className="relative flex flex-col gap-2 rounded-xl border border-line bg-elevated py-2 pr-2 pl-4 shadow-card transition-[border-color,box-shadow] duration-150 focus-within:border-line-focus focus-within:ring-4 focus-within:ring-focus"
        >
          {suggestions.menu}
          <label htmlFor={textId} className="sr-only">
            {placeholders[team ? target : "pi"]}
          </label>
          {replying && (
            <p className="flex items-start gap-2 border-l-2 border-line-strong pl-2 text-label text-fg-dim">
              <span className="min-w-0 flex-1">
                Replying to <span className="font-medium">{replying.by}</span>
                <span className="line-clamp-1">{replying.quote.text}</span>
              </span>
              <Button
                variant="ghost"
                size="xs"
                iconOnly
                aria-label="Cancel the reply"
                onClick={onReplied}
              >
                <Icon name="x" className="size-3.5" />
              </Button>
            </p>
          )}
          {team && target === "pi" && (
            <TeamTalk
              unread={teamTalkSince(feed.voices).length}
              onFork={
                onFork &&
                (() => {
                  const draft = text.current?.value ?? "";

                  if (text.current) {
                    text.current.value = "";
                  }

                  onFork(draft);
                })
              }
            />
          )}
          <AttachedImages
            images={images}
            onRemove={(id) => {
              setImages((current) => current.filter((each) => each.id !== id));
            }}
          />
          <textarea
            ref={text}
            id={textId}
            name="text"
            rows={2}
            placeholder={placeholders[team ? target : "pi"]}

            {...suggestions.box}
            onInput={(event) => {
              suggestions.box.onInput(event);

              if (team && event.currentTarget.value.includes("@pipoca")) {
                setTarget("pi");
              }
            }}
            onPaste={(event) => {
              const pasted = [...event.clipboardData.files];

              // Excel and Word put a picture of the copied cells or text next
              // to the text itself, as HTML. A copied file has no HTML.
              if (
                pasted.length > 0 &&
                !event.clipboardData.types.includes("text/html")
              ) {
                event.preventDefault();
                attach(pasted);
              }
            }}
            onKeyDown={(event) => {
              if (isComposing(event) || suggestions.keyDown(event)) {
                return;
              }

              const steer = event.metaKey || event.ctrlKey;

              // On a phone Enter is the only way to start a new line, so the
              // Send button sends, as in Claude Code on the web.
              if (
                event.key !== "Enter" ||
                event.shiftKey ||
                (!steer && matchMedia("(pointer: coarse)").matches)
              ) {
                return;
              }

              event.preventDefault();
              send(steer ? "steer" : "followUp");
            }}
            className="max-h-72 min-h-12 resize-none field-sizing-content bg-transparent pt-1 text-prose text-fg placeholder:text-fg-dim focus:outline-none"
          />
          <Toolbar
            sessionId={sessionId}
            feed={feed}
            models={models}
            hiddenModels={hiddenModels}
            modelMenu={modelMenu}
            team={team}
            target={target}
            onTarget={setTarget}
            running={running}
            attach={attach}
            report={report}
          />
        </form>
      )}

      <Widgets widgets={feed.widgetsBelow} />

      {feed.footer === undefined ? (
        feed.statuses.length > 0 && (
          <footer className="px-2 text-caption text-fg-dim">
            <Styled text={feed.statuses.join(" · ")} />
          </footer>
        )
      ) : (
        <footer>
          <TerminalText text={feed.footer} className="text-fg-dim" />
        </footer>
      )}
    </div>
  );
}
