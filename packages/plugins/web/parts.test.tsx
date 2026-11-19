import { expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import { renderPart } from "./testing";
import { definePlugin } from "../src/definition";
import { defineWeb, type MountedSession, useLoaded } from "./index";

interface Listener {
  readonly type: string;
  readonly fn: (event: { readonly data: string }) => void;
}

class FakeStream {
  static opened: FakeStream[] = [];
  readonly readyState = 1;
  readonly listeners: Listener[] = [];

  constructor() {
    FakeStream.opened.push(this);
  }

  addEventListener(type: string, fn: Listener["fn"]): void {
    this.listeners.push({ type, fn });
  }

  changed(topic: string): void {
    for (const { type, fn } of this.listeners) {
      if (type === "message") {
        fn({ data: JSON.stringify({ topic }) });
      }
    }
  }

  close(): void {
    this.listeners.length = 0;
  }
}

const votes = definePlugin({ id: "votes", title: "Votes", description: "" });

let loads = 0;

function Count(_props: { readonly session: MountedSession }) {
  const { value } = useLoaded(
    async () => {
      loads += 1;

      return Promise.resolve(loads);
    },
    "count",
    { changes: ["tally"] },
  );

  return <p>{value}</p>;
}

const web = defineWeb(votes, { slots: { "session.header": Count } });

test("a part's changes are its own topics, by the name its routes give them", async () => {
  const globals = globalThis as unknown as { EventSource: unknown };
  const original = globals.EventSource;
  globals.EventSource = FakeStream;

  try {
    renderPart(web, "session.header", {});
    await sleep(50);
    const before = loads;

    FakeStream.opened.at(-1)?.changed("tally");
    await sleep(300);

    expect(loads).toBe(before);

    FakeStream.opened.at(-1)?.changed("votes.tally");
    await sleep(300);

    expect(loads).toBe(before + 1);
  } finally {
    globals.EventSource = original;
  }
});
