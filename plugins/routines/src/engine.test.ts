import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  eventBus,
  type PluginRoute,
  type PluginStore,
  type SendOutcome,
  type ServerTool,
  type StartRequest,
} from "@pipoca/plugins";
import {
  fakeContext,
  fakeSession,
  fakeUser,
  memoryStore,
  served,
} from "@pipoca/plugins/testing";
import type { Session } from "@pipoca/protocol";
import type { RoutineDetail, RoutineView, Run } from "./model";
import { routines as plugin } from "./server";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "routines-"));
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-11-03T07:00:00Z"));
});

afterEach(() => {
  jest.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const daily = {
  title: "Summarise new issues",
  triggers: [{ cron: "0 8 * * *", timeZone: "UTC" }],
  run: {
    prompt: "Summarise yesterday's new issues.",
    workspace: { kind: "clone", repository: "https://github.com/o/r" },
  },
};

interface Started {
  readonly request: StartRequest;
  readonly ownerKey: string | undefined;
  readonly session: Session;
}

function start({
  store = memoryStore(),
  send = (): SendOutcome => ({ ok: true }),
}: { store?: PluginStore; send?: () => SendOutcome } = {}) {
  const started: Started[] = [];
  const sent: { id: string; text: string }[] = [];
  const tools: ServerTool[] = [];

  const bus = eventBus((_type, error) => {
    throw error;
  });

  const stop = new AbortController();
  let route: PluginRoute | undefined;

  plugin.register(
    fakeContext({
      tools: {
        register: (tool) => {
          tools.push(tool);
        },
      },
      events: bus,
      routes: {
        handle: (handler) => {
          route = served(handler);
        },
      },
      sessions: {
        ...fakeContext().sessions,
        start: (request, ownerKey) => {
          const session = fakeSession({
            id: `run-${String(started.length + 1)}`,
            owner:
              ownerKey === undefined
                ? null
                : { plugin: "routines", key: ownerKey },
            startedBy: "owner",
          });

          started.push({ request, ownerKey, session });

          return session;
        },
        send: (id, text) => {
          const outcome = send();
          if (outcome.ok) {
            sent.push({ id, text });
          }

          return outcome;
        },
      },
      environments: {
        ...fakeContext().environments,
        list: () => [],
      },
      config: { get: () => undefined, set: () => undefined, dir },
      store,
      signal: stop.signal,
    }),
  );

  const request = async (
    path: string,
    method = "GET",
    body?: unknown,
    user = "owner",
  ): Promise<{ status: number; body: unknown }> => {
    const response = await (route?.(
      new Request(`http://pipoca/api/plugins/routines/${path}`, {
        method,
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
      path,
      fakeUser({ id: user }),
    ) as Promise<Response>);

    return { status: response.status, body: await response.json() };
  };

  const turnEnded = (session: Session) => {
    bus.publish({ type: "TurnEnded", session });
  };

  const reportNothing = tools.find(({ name }) => name === "report_nothing");

  return { started, sent, request, turnEnded, bus, stop, reportNothing };
}

const minutes = (count: number) => {
  jest.advanceTimersByTime(count * 60_000);
};

const runsOf = async (
  it: ReturnType<typeof start>,
  name = "daily",
): Promise<readonly Run[]> =>
  ((await it.request(`routines/${name}`)).body as RoutineDetail).runs;

test("a scheduled routine starts its own Session at its time and ends ok with the turn", async () => {
  const it = start();

  expect((await it.request("routines/daily", "PUT", daily)).status).toBe(200);

  expect(
    JSON.parse(readFileSync(join(dir, "owner", "daily.json"), "utf8")),
  ).toEqual(daily);

  minutes(59);
  expect(it.started).toEqual([]);

  minutes(1);
  const [run] = it.started;

  expect(run?.ownerKey).toBe("owner:daily");

  expect(run?.request).toMatchObject({
    actor: "user:owner",
    workspace: daily.run.workspace,
    firstMessage: "Summarise yesterday's new issues.",
  });

  expect(run?.request.systemPrompt).toContain("report_nothing");

  expect((await runsOf(it))[0]).toMatchObject({
    outcome: "running",
    cause: "schedule",
    sessionId: "run-1",
  });

  it.turnEnded(run?.session ?? fakeSession());
  expect((await runsOf(it))[0]?.outcome).toBe("ok");

  const [listed] = (await it.request("routines")).body as RoutineView[];

  expect(listed).toMatchObject({
    name: "daily",
    title: "Summarise new issues",
    paused: null,
    nextAt: "2026-11-04T08:00:00.000Z",
  });
});

test("a run with nothing to do ends as nothing", async () => {
  const it = start();
  await it.request("routines/daily", "PUT", daily);

  const run = (await it.request("routines/daily/run", "POST")).body as Run;
  expect(run.cause).toBe("by hand");

  const session = it.started[0]?.session ?? fakeSession();

  const result = await it.reportNothing?.run(
    {},
    { session, actor: `session:${session.id}` },
  );

  expect(result?.isError).toBe(false);
  it.turnEnded(session);

  expect((await runsOf(it))[0]?.outcome).toBe("nothing");
  expect(it.reportNothing?.appliesTo(fakeSession())).toBe(false);
  expect(it.reportNothing?.appliesTo(session)).toBe(true);
});

test("skips a firing while the last run is still going, or queues one", async () => {
  const it = start();
  await it.request("routines/daily", "PUT", daily);
  await it.request("routines/daily/run", "POST");
  await it.request("routines/daily/run", "POST");

  expect(it.started).toHaveLength(1);

  expect((await runsOf(it))[0]).toMatchObject({
    outcome: "skipped",
    reason: "the last run was still going",
  });

  await it.request("routines/daily", "PUT", {
    ...daily,
    overlap: "queue",
  });

  await it.request("routines/daily/run", "POST");
  await it.request("routines/daily/run", "POST");

  expect((await runsOf(it)).map(({ outcome }) => outcome)).toEqual([
    "skipped",
    "queued",
    "skipped",
    "running",
  ]);

  it.turnEnded(it.started[0]?.session ?? fakeSession());
  expect(it.started).toHaveLength(2);
});

test("pauses a routine after three failed runs in a row, until the person resumes it", async () => {
  const it = start();
  await it.request("routines/daily", "PUT", daily);

  for (let at = 0; at < 3; at++) {
    await it.request("routines/daily/run", "POST");
    const session = it.started[at]?.session ?? fakeSession();

    it.bus.publish({
      type: "SessionStateChanged",
      session: { ...session, status: "failed", error: "model refused" },
      previous: "running",
    });
  }

  const paused = (await it.request("routines/daily")).body as RoutineDetail;

  expect(paused.paused).toBe(
    "Paused after 3 failed runs in a row. The last: model refused",
  );

  minutes(60);
  expect(it.started).toHaveLength(3);

  await it.request("routines/daily/resume", "POST");
  minutes(24 * 60);
  expect(it.started).toHaveLength(4);
});

test("missed firings while the server was down become one catch-up run, after it starts", async () => {
  const store = memoryStore();
  const before = start({ store });

  await before.request("routines/hourly", "PUT", {
    ...daily,
    triggers: [{ cron: "0 * * * *", timeZone: "UTC" }],
  });

  before.stop.abort();

  jest.setSystemTime(new Date("2026-11-03T12:30:00Z"));
  const after = start({ store });

  expect(after.started).toEqual([]);
  jest.advanceTimersByTime(30_000);
  expect(after.started).toHaveLength(1);

  minutes(29);
  expect(after.started).toHaveLength(1);
  after.turnEnded(after.started[0]?.session ?? fakeSession());
  minutes(1);
  expect(after.started).toHaveLength(2);
});

test("reads routines written by hand and says why one doesn't load", async () => {
  mkdirSync(join(dir, "owner"));
  writeFileSync(join(dir, "owner", "daily.json"), JSON.stringify(daily));

  writeFileSync(
    join(dir, "owner", "broken.json"),
    JSON.stringify({
      ...daily,
      triggers: [{ cron: "0 8 * *", timeZone: "UTC" }],
    }),
  );

  const it = start();
  const listed = (await it.request("routines")).body as RoutineView[];

  expect(listed.map(({ name, error }) => ({ name, error }))).toEqual([
    {
      name: "broken",
      error: "a cron expression has five fields: minute hour day month weekday",
    },
    { name: "daily", error: undefined },
  ]);

  minutes(60);
  expect(it.started).toHaveLength(1);
});

test("a routine can message one of the person's Sessions", async () => {
  const it = start();

  await it.request("routines/nudge", "PUT", {
    title: "Nudge",
    triggers: [{ at: "2026-11-03T07:10:00Z" }],
    run: { prompt: "Check the deploy.", session: "session-9" },
  });

  minutes(9);
  expect(it.sent).toEqual([]);
  minutes(1);

  expect(it.sent).toEqual([{ id: "session-9", text: "Check the deploy." }]);

  expect((await runsOf(it, "nudge"))[0]?.outcome).toBe("ok");
});

test("refuses a routine that doesn't fit and keeps each person's routines apart", async () => {
  const it = start();

  const refused = await it.request("routines/daily", "PUT", {
    ...daily,
    triggers: [{ cron: "0 8 * * *", timeZone: "Mars/Olympus" }],
  });

  expect(refused).toMatchObject({
    status: 400,
    body: { message: "Mars/Olympus isn't a time zone, such as Europe/Berlin" },
  });

  expect((await it.request("routines/Bad Name", "PUT", daily)).status).toBe(
    400,
  );

  await it.request("routines/daily", "PUT", daily);

  expect(
    (await it.request("routines", "GET", undefined, "other")).body,
  ).toEqual([]);

  expect(
    (await it.request("routines/daily", "GET", undefined, "other")).status,
  ).toBe(404);

  expect((await it.request("routines/daily", "DELETE")).status).toBe(200);
  expect((await it.request("routines")).body).toEqual([]);
});
