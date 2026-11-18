import { useCompletion } from "@pipoca/ui";
import type { Feed } from "../feed";
import { ranked, type Trigger, trigger } from "./suggest";

const labels = { command: "Commands", file: "Files" } as const;

// The `/` command and `@` file menu under the composer's caret (ADR 0006).
export function useSuggestions(feed: Feed): ReturnType<typeof useCompletion> {
  return useCompletion({
    mono: true,
    find: (text, caret) => {
      const typed = trigger(text, caret);

      return typed && { ...typed, label: labels[typed.kind] };
    },
    options: (typed) => optionsFor(typed, feed),
  });
}

function optionsFor(
  typed: Trigger,
  feed: Feed,
): readonly { value: string; detail: string | null }[] {
  switch (typed.kind) {
    case "command":
      return ranked(feed.commands, typed.query, ({ name }) => name).map(
        ({ name, description }) => ({ value: `/${name}`, detail: description }),
      );
    case "file":
      return ranked(feed.files, typed.query, (path) => path).map((path) => ({
        value: `@${path}`,
        detail: null,
      }));
  }
}
