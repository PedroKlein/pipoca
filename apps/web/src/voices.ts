import type { Voice } from "@pipoca/protocol";
import type { FeedItem } from "./feed";

// Names each team message's sender, matching messages to what was sent in
// order, and puts each stop where it happened.
export function voiced(
  items: readonly FeedItem[],
  voices: readonly Voice[],
  name: (person: string) => string,
): readonly FeedItem[] {
  if (voices.length === 0) {
    return items;
  }

  const sent = voices.filter(({ kind }) => kind === "message");

  const named = items.map((item): FeedItem => {
    if (item.role !== "user") {
      return item;
    }

    const at = sent.findIndex(({ text }) => text === item.text);
    const [voice] = at === -1 ? [] : sent.splice(at, 1);

    return voice === undefined ? item : { ...item, by: name(voice.person) };
  });

  return voices
    .filter(({ kind }) => kind === "stop")
    .reduce<readonly FeedItem[]>((shown, stop, index) => {
      const after = shown.findIndex(
        (item) => item.at !== undefined && item.at > stop.at,
      );

      const note: FeedItem = {
        role: "note",
        text: `${name(stop.person)} stopped it.`,
        at: stop.at,
        key: -1 - index,
      };

      return after === -1
        ? [...shown, note]
        : [...shown.slice(0, after), note, ...shown.slice(after)];
    }, named);
}
