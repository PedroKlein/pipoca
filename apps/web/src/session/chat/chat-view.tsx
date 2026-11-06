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
} from "react";
import { useQuery } from "../../data/hooks";
import { usePrimaryId } from "../../primary";
import type { Feed } from "../feed";
import { TerminalText } from "../terminal/terminal-text";
import { turns } from "./chat";
import { Answer } from "./markdown";
import { claimed } from "./tool-card";
import { turnItems } from "./turn";
import { voiced } from "./voices";

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
  const atBottom = useRef(true);
  const top = useRef(0);
  const people = useQuery("people.list").data;

  const shown = useMemo(() => {
    const names = new Map((people ?? []).map(({ id, name }) => [id, name]));

    return turns(
      voiced(
        feed.items,
        feed.voices,
        (person) => names.get(person) ?? "Someone",
      ),
      claimed,
    );
  }, [feed.items, feed.voices, people]);

  const chatId = usePrimaryId("chat");

  const live =
    feed.session?.status === "running" ||
    feed.streaming !== undefined ||
    feed.tools.length > 0;

  const now = useNow();

  useLayoutEffect(() => {
    const box = scroller.current;
    if (box && !hidden) {
      // A hidden box loses its scroll position, so it is put back on showing.
      box.scrollTop = atBottom.current ? box.scrollHeight : top.current;
    }
  }, [feed.items, feed.streaming, feed.tools, feed.prompts, hidden]);

  // Widgets drawn around the composer shrink the chat after it has scrolled.
  useEffect(() => {
    const box = scroller.current;
    if (!box || hidden) {
      return;
    }

    const observer = new ResizeObserver(() => {
      if (atBottom.current) {
        box.scrollTop = box.scrollHeight;
      }
    });

    observer.observe(box);

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
        id={chatId}
        className="mx-auto flex max-w-chat flex-col gap-5 px-4 pt-8 pb-10"
      >
        {shown.map((turn, index) =>
          turnItems({
            turn,
            tools: feed.tools,
            last: index === shown.length - 1,
            first: index === 0,
            live,
            now,
            session,
            onReply,
          }),
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
