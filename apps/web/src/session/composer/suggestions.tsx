import type { Teammate } from "@pipoca/protocol";
import { type Completion, useCompletion } from "@pipoca/ui";
import { useMe, useQuery } from "../../data/hooks";
import type { Feed } from "../feed";
import { ranked, type Trigger, trigger } from "./suggest";

// The `/` command and `@` file menu under the composer's caret (ADR 0006).
// In team work others see, `@` also names people (ADR 0065).
export function useSuggestions(
  feed: Feed,
  talk: boolean,
): ReturnType<typeof useCompletion> {
  const me = useMe().user.id;

  const people = (
    useQuery("people.list", undefined, { enabled: talk }).data ?? []
  ).filter(({ id }) => id !== me);

  return useCompletion({
    mono: true,
    find: (text, caret) => {
      const typed = trigger(text, caret);

      return typed && { ...typed, label: labelOf(typed.kind, talk) };
    },
    options: (typed) => optionsFor(typed, feed, talk ? people : []),
  });
}

function optionsFor(
  typed: Trigger,
  feed: Feed,
  people: readonly Teammate[],
): readonly Completion[] {
  switch (typed.kind) {
    case "command":
      return ranked(feed.commands, typed.query, ({ name }) => name).map(
        ({ name, description }) => ({ value: `/${name}`, detail: description }),
      );
    case "file":
      return [
        ...ranked(people, typed.query, handleOf).map((each) => ({
          value: `@${handleOf(each)}`,
          detail: each.username === undefined ? null : each.name,
        })),
        ...ranked(feed.files, typed.query, (path) => path).map((path) => ({
          value: `@${path}`,
          detail: null,
        })),
      ];
  }
}

function labelOf(kind: Trigger["kind"], talk: boolean): string {
  if (kind === "command") {
    return "Commands";
  }

  return talk ? "People and files" : "Files";
}

function handleOf({ name, username }: Teammate): string {
  return username ?? name;
}
