import { apiPath, type Presence } from "@pipoca/protocol";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { request } from "../data/client";
import { useQuery } from "../data/hooks";

const typingEveryMs = 3000;

// Who else is looking at team work, while the person looks at it too
// (ADR 0054).
export function usePresence(
  sessionId: string,
  team: boolean,
): readonly Presence[] {
  const [people, setPeople] = useState<readonly Presence[]>([]);

  useEffect(() => {
    if (!team) {
      return undefined;
    }

    const stream = new EventSource(
      apiPath("sessions.presence", { params: { id: sessionId } }),
    );

    stream.addEventListener("message", (event: MessageEvent<string>) => {
      setPeople(JSON.parse(event.data) as readonly Presence[]);
    });

    return () => {
      stream.close();
      setPeople([]);
    };
  }, [sessionId, team]);

  return people;
}

// Tells the others the person is typing, at most every few seconds.
export function useTyping(sessionId: string, team: boolean): () => void {
  const last = useRef(0);

  return () => {
    const now = Date.now();

    if (!team || now - last.current < typingEveryMs) {
      return;
    }

    last.current = now;

    void request("sessions.presence.typing", {
      params: { id: sessionId },
    }).catch(() => undefined);
  };
}

export function PresenceLine({
  people,
  me,
}: {
  readonly people: readonly Presence[];
  readonly me: string;
}): ReactElement | null {
  const teammates = useQuery("people.list").data ?? [];
  const others = people.filter(({ person }) => person !== me);

  if (others.length === 0) {
    return null;
  }

  const names = new Map(teammates.map(({ id, name }) => [id, name]));
  const name = (person: string): string => names.get(person) ?? "Someone";

  const typing = others
    .filter((other) => other.typing)
    .map(({ person }) => name(person));

  return (
    <p
      aria-live="polite"
      data-role="presence"
      className="mx-auto w-full max-w-chat px-4 pb-1 text-caption text-fg-dim"
    >
      {typing.length > 0
        ? `${listed(typing)} ${typing.length === 1 ? "is" : "are"} typing…`
        : `${listed(others.map(({ person }) => name(person)))} ${others.length === 1 ? "is" : "are"} here too`}
    </p>
  );
}

function listed(names: readonly string[]): string {
  return names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}
