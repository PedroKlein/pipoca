import { useNow } from "@pipoca/plugins/web";
import type { MountedSession } from "@pipoca/plugins/web";
import type { Quote } from "@pipoca/protocol";
import { Mark } from "@pipoca/ui";
import {
  type ReactElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePersonName } from "../../data/hooks";
import { usePrimaryId } from "../../primary";
import type { Feed } from "../feed";
import { TerminalText } from "../terminal/terminal-text";
import { foldNotices, turns } from "./chat";
import { Answer } from "./markdown";
import { claimed } from "./tool-card";
import { turnItems } from "./turn";
import { voiced } from "./voices";

// A long chat opens on its latest turns and draws older ones as you scroll
// up, as in Claude Code, so a big Session opens at once and at its end.
const turnsPerPage = 30;

export function ChatView({
  feed,
  session,
  place,
  hidden,
  onReply,
}: {
  readonly feed: Feed;
  readonly session: MountedSession;
  readonly place: string;
  readonly hidden: boolean;
  // In team work, a message can quote the one it answers (ADR 0065).
  readonly onReply?: (quote: Quote) => void;
}): ReactElement {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLOListElement>(null);
  const atBottom = useRef(true);
  const top = useRef(0);
  const nameOf = usePersonName();

  const shown = useMemo(
    () =>
      foldNotices(
        turns(
          voiced(
            feed.items,
            feed.voices,
            (person) => nameOf(person) ?? "Someone",
          ),
          claimed,
        ),
      ),
    [feed.items, feed.voices, nameOf],
  );

  const [limit, setLimit] = useState(turnsPerPage);
  const start = Math.max(0, shown.length - limit);

  // Where the list ended before older turns were drawn above, to keep the
  // same turns in view.
  const before = useRef<number | undefined>(undefined);

  const showOlder = (): void => {
    const box = scroller.current;

    if (start === 0 || !box || before.current !== undefined) {
      return;
    }

    before.current = box.scrollHeight - box.scrollTop;
    setLimit((count) => count + turnsPerPage);
  };

  useLayoutEffect(() => {
    const box = scroller.current;

    if (box && before.current !== undefined) {
      box.scrollTop = box.scrollHeight - before.current;
      top.current = box.scrollTop;
      before.current = undefined;
    }
  }, [limit]);

  const chatId = usePrimaryId("chat");

  const live =
    feed.session?.status === "running" ||
    feed.streaming !== undefined ||
    feed.thinking !== undefined ||
    feed.tools.length > 0;

  const now = useNow();

  useLayoutEffect(() => {
    const box = scroller.current;
    if (box && !hidden) {
      // A hidden box loses its scroll position, so it is put back on showing.
      box.scrollTop = atBottom.current ? box.scrollHeight : top.current;
    }
  }, [
    feed.items,
    feed.streaming,
    feed.thinking,
    feed.tools,
    feed.prompts,
    hidden,
  ]);

  // Widgets drawn around the composer shrink the chat after it has scrolled,
  // and turns grow after it, as off-screen ones get drawn and diagrams,
  // images and folded tool runs take their size.
  useEffect(() => {
    const box = scroller.current;
    const list = content.current;
    if (!box || !list || hidden) {
      return;
    }

    const observer = new ResizeObserver(() => {
      if (atBottom.current) {
        box.scrollTop = box.scrollHeight;
      }
    });

    observer.observe(box);
    observer.observe(list);

    return () => {
      observer.disconnect();
    };
  }, [hidden]);

  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const box = event.currentTarget;

        atBottom.current =
          box.scrollHeight - box.scrollTop - box.clientHeight < 40;

        top.current = box.scrollTop;

        if (box.scrollTop < 200) {
          showOlder();
        }
      }}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      {feed.header !== undefined && (
        <header className="mx-auto max-w-chat px-4 pt-8">
          <TerminalText text={feed.header} />
        </header>
      )}
      {shown.length === 0 && !live && feed.session && (
        <Greeting place={place} />
      )}
      <ol
        ref={content}
        id={chatId}
        className="mx-auto flex max-w-chat flex-col gap-5 px-4 pt-8 pb-10"
      >
        {start > 0 && (
          <li className="self-center">
            <button
              type="button"
              onClick={showOlder}
              className="cursor-pointer text-label text-fg-dim hover:text-fg"
            >
              Show earlier messages
            </button>
          </li>
        )}
        {shown.slice(start).map((turn, index) =>
          turnItems({
            turn,
            tools: feed.tools,
            last: start + index === shown.length - 1,
            first: start + index === 0,
            live,
            now,
            session,
            onReply,
          }),
        )}
        {feed.thinking !== undefined && (
          <li
            data-role="thinking"
            className="flex min-w-0 items-center gap-2 px-1 text-label text-fg-dim"
          >
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-working" />
            <span className="shrink-0 font-medium text-working">Thinking</span>
            <span className="truncate">{lastLine(feed.thinking)}</span>
          </li>
        )}
        {feed.streaming !== undefined && (
          <li data-role="assistant">
            <Answer text={feed.streaming} />
          </li>
        )}
      </ol>
    </div>
  );
}

function lastLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .findLast((line) => line !== "") ?? ""
  );
}

function Greeting({ place }: { readonly place: string }): ReactElement {
  return (
    <div className="mx-auto flex max-w-chat flex animate-rise-in flex-col items-center gap-3 px-4 pt-[18vh] text-center">
      <Mark className="size-12" />
      <p className="font-serif text-display font-light text-fg-strong">
        What should Pi do in {place}?
      </p>
      <p className="text-label text-fg-dim">
        Ask below. Pi works in the session&apos;s workspace and can run commands
        there.
      </p>
    </div>
  );
}
