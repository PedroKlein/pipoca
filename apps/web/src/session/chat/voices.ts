import type { Quote, Voice } from "@pipoca/protocol";
import type { Quoted } from "./chat";
import type { FeedItem } from "../feed";

// Names each team message's sender, matching messages to what was sent in
// order, and puts what people said to each other, and each stop, where it
// happened.
export function voiced(
  items: readonly FeedItem[],
  voices: readonly Voice[],
  name: (person: string) => string,
): readonly FeedItem[] {
  if (voices.length === 0) {
    return items;
  }

  const sent = voices.filter(({ kind }) => kind === "message");

  const quoted = (quote: Quote | undefined): { quote?: Quoted } =>
    quote === undefined
      ? {}
      : {
          quote: {
            by: quote.from === "pi" ? "Pi" : name(quote.from),
            text: quote.text,
          },
        };

  const named = items.map((item): FeedItem => {
    if (item.role !== "user") {
      return item;
    }

    const at = sent.findIndex(({ text }) => text === item.text);
    const [voice] = at === -1 ? [] : sent.splice(at, 1);

    return voice === undefined
      ? item
      : {
          ...item,
          by: name(voice.person),
          from: voice.person,
          ...quoted(voice.quote),
        };
  });

  return voices.reduce<readonly FeedItem[]>((shown, voice, index) => {
    const key = -1 - index;

    const said = spoken(voice, key, name, quoted);

    if (said === undefined) {
      return shown;
    }

    const after = shown.findIndex(
      (item) => item.at !== undefined && item.at > voice.at,
    );

    return after === -1
      ? [...shown, said]
      : [...shown.slice(0, after), said, ...shown.slice(after)];
  }, named);
}

function spoken(
  voice: Voice,
  key: number,
  name: (person: string) => string,
  quoted: (quote: Quote | undefined) => { quote?: Quoted },
): FeedItem | undefined {
  switch (voice.kind) {
    case "stop":
      return {
        role: "note",
        text: `${name(voice.person)} stopped it.`,
        at: voice.at,
        key,
      };
    case "notice":
      return voice.notice === undefined
        ? undefined
        : {
            role: "notice",
            text: voice.text ?? "",
            notice: voice.notice,
            at: voice.at,
            key,
          };
    case "team":
    case "aside":
      return {
        role: "team",
        text: voice.text ?? "",
        from: voice.person,
        by: name(voice.person),
        aside: voice.kind === "aside",
        ...quoted(voice.quote),
        at: voice.at,
        key,
      };
    case "message":
      return undefined;
  }
}
