import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  eventBus,
  type PluginNotice,
  type PluginRoute,
  type PluginStore,
  type SendOutcome,
  type ServerTool,
} from "@pipoca/plugins";
import {
  fakeContext,
  fakeSession,
  fakeUser,
  memoryStore,
  served,
} from "@pipoca/plugins/testing";
import { routinesSchema } from "./engine";
import type { ToolResult } from "@pipoca/protocol";
import { routines } from "./server";

interface Sent {
  readonly id: string;
  readonly text: string;
  readonly notice: PluginNotice | undefined;
}

const session = fakeSession({ id: "session-1", startedBy: "owner" });

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-11-03T08:00:00Z"));
});

afterEach(() => {
  jest.useRealTimers();
});

function start(
  outcome: () => SendOutcome = () => ({ ok: true }),
  store: PluginStore = memoryStore(routinesSchema),
) {
  const sent: Sent[] = [];
  const tools: ServerTool[] = [];

  const bus = eventBus((_type, error) => {
    throw error;
  });

  let route: PluginRoute | undefined;
  const stop = new AbortController();

  routines.register(
    fakeContext({
      tools: {
        register: (tool) => {
          tools.push(tool);
        },
      },
      events: { ...bus, declared: () => [] },
      routes: {
        handle: (handler) => {
          route = served(handler);
        },
      },
      auth: { ...fakeContext().auth, handlePublic: () => undefined },
      sessions: {
        ...fakeContext().sessions,
        send: (id, text, _actor, notice) => {
          const result = outcome();
          if (result.ok) {
            sent.push({ id, text, notice });
          }

          return result;
        },
      },
      signal: stop.signal,
      store,
      config: {
        get: () => undefined,
        set: () => undefined,
        lockedIn: () => undefined,
        dir: mkdtempSync(join(tmpdir(), "routines-")),
      },
    }),
  );

  const [tool] = tools;
  if (tool === undefined || route === undefined) {
    throw new Error("routines registered no tool or route");
  }

  const call = async (input: unknown, from = session): Promise<ToolResult> =>
    tool.run(input, { session: from, actor: `session:${from.id}` });

  const request = async (path: string, method = "GET", user = "owner") =>
    route?.(
      new Request(`http://pipoca/api/plugins/routines/${path}`, { method }),
      path.split("?")[0] ?? "",
      fakeUser({ id: user }),
    ) as Promise<Response>;

  return { sent, tool, call, request, bus, stop };
}

const minutes = (count: number) => {
  jest.advanceTimersByTime(count * 60_000);
};

test("a wake-up comes back to its Session as a notice at its time", async () => {
  const { sent, call } = start();

  const result = await call({
    delay_minutes: 15,
    reason: "Check CI on #552",
    message: "See whether the checks on #552 passed.",
  });

  expect(result.isError).toBe(false);
  minutes(14);
  expect(sent).toEqual([]);

  minutes(1);

  expect(sent).toEqual([
    {
      id: "session-1",
      text: "Wake-up you scheduled: Check CI on #552\n\nSee whether the checks on #552 passed.",
      notice: { kind: "wakeup", data: { reason: "Check CI on #552" } },
    },
  ]);

  minutes(60);
  expect(sent).toHaveLength(1);
});

test("a wake-up at a time comes then", async () => {
  const { sent, call } = start();

  await call({
    at: "2026-11-03T10:00:00+01:00",
    reason: "Morning check",
    message: "Look at the overnight runs.",
  });

  minutes(59);
  expect(sent).toEqual([]);
  minutes(1);
  expect(sent).toHaveLength(1);
});

test("a wake-up for an offline Session waits for it to come online", async () => {
  let online = false;

  const { sent, call } = start(() =>
    online ? { ok: true } : { ok: false, reason: "offline" },
  );

  await call({ delay_minutes: 1, reason: "Later", message: "Carry on." });

  minutes(1);
  expect(sent).toEqual([]);

  online = true;
  jest.advanceTimersByTime(30_000);
  expect(sent).toHaveLength(1);
});

test("a wake-up for a Session that is gone is dropped", async () => {
  let calls = 0;

  const { call } = start(() => {
    calls += 1;

    return { ok: false, reason: "not_found" };
  });

  await call({ delay_minutes: 1, reason: "Later", message: "Carry on." });

  minutes(10);
  expect(calls).toBe(1);
  expect((await call({ action: "list" })).text).toBe("No pending wake-ups.");
});

test("wake-ups are 1 minute to 30 days ahead", async () => {
  const { call } = start();
  const ask = { reason: "Later", message: "Carry on." };

  expect((await call({ ...ask, delay_minutes: 0.5 })).isError).toBe(true);

  expect((await call({ ...ask, delay_minutes: 31 * 24 * 60 })).isError).toBe(
    true,
  );

  expect((await call({ ...ask, at: "2026-11-03T09:00:00" })).text).toBe(
    "at must be an ISO 8601 time with a time zone",
  );

  expect((await call({ ...ask })).text).toBe("give either delay_minutes or at");

  expect((await call({ ...ask, delay_minutes: 30 * 24 * 60 })).isError).toBe(
    false,
  );
});

test("a Session has at most 10 pending wake-ups", async () => {
  const { call } = start();

  for (let at = 1; at <= 10; at++) {
    const result = await call({
      delay_minutes: at,
      reason: "Later",
      message: "Carry on.",
    });

    expect(result.isError).toBe(false);
  }

  const refused = await call({
    delay_minutes: 11,
    reason: "Later",
    message: "Carry on.",
  });

  expect(refused).toEqual({
    text: "this Session already has 10 pending wake-ups; cancel one first",
    isError: true,
  });
});

test("a Session wakes up at most 48 times a day", async () => {
  const { sent, call } = start();

  for (let at = 1; at <= 48; at++) {
    await call({ delay_minutes: 1, reason: "Again", message: "Carry on." });
    minutes(1);
  }

  expect(sent).toHaveLength(48);

  const refused = await call({
    delay_minutes: 1,
    reason: "Again",
    message: "Carry on.",
  });

  expect(refused.isError).toBe(true);

  minutes(24 * 60);

  expect(
    (await call({ delay_minutes: 1, reason: "Again", message: "Carry on." }))
      .isError,
  ).toBe(false);
});

test("the Session lists and cancels its wake-ups", async () => {
  const { sent, call } = start();

  const scheduled = await call({
    delay_minutes: 5,
    reason: "Check CI",
    message: "Check it.",
  });

  const id = /wake-up (\S+) for/.exec(scheduled.text)?.[1] ?? "";

  expect((await call({ action: "list" })).text).toBe(
    `${id}: 2026-11-03T08:05:00.000Z, Check CI`,
  );

  expect(
    (await call({ action: "list" }, fakeSession({ id: "session-2" }))).text,
  ).toBe("No pending wake-ups.");

  expect(
    (await call({ action: "cancel", id }, fakeSession({ id: "session-2" })))
      .isError,
  ).toBe(true);

  expect((await call({ action: "cancel", id })).text).toBe(
    `Cancelled wake-up ${id}.`,
  );

  minutes(10);
  expect(sent).toEqual([]);
});

test("archiving a Session cancels its wake-ups", async () => {
  const { sent, call, bus } = start();

  await call({ delay_minutes: 5, reason: "Later", message: "Carry on." });
  bus.publish({ type: "SessionArchived", session });

  minutes(10);
  expect(sent).toEqual([]);
});

test("the person sees and cancels their Session's wake-ups", async () => {
  const { sent, call, request } = start();

  await call({ delay_minutes: 5, reason: "Check CI", message: "Check it." });

  const listed = (await (
    await request("wakeups?session=session-1")
  ).json()) as { id: string; reason: string; dueAt: string }[];

  expect(listed.map(({ reason, dueAt }) => ({ reason, dueAt }))).toEqual([
    { reason: "Check CI", dueAt: "2026-11-03T08:05:00.000Z" },
  ]);

  expect(
    await (await request("wakeups?session=session-1", "GET", "other")).json(),
  ).toEqual([]);

  const id = listed[0]?.id ?? "";

  expect((await request(`wakeups/${id}`, "DELETE", "other")).status).toBe(404);
  expect((await request(`wakeups/${id}`, "DELETE")).status).toBe(200);

  minutes(10);
  expect(sent).toEqual([]);
});

test("pending wake-ups survive a restart", async () => {
  const store = memoryStore(routinesSchema);
  const before = start(undefined, store);

  await before.call({ delay_minutes: 5, reason: "Later", message: "Go on." });
  before.stop.abort();

  const after = start(undefined, store);

  minutes(5);
  expect(before.sent).toEqual([]);
  expect(after.sent).toHaveLength(1);
});
