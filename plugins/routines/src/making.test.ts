import { expect, test } from "bun:test";
import {
  definePlugin,
  defineServer,
  event,
  type Owner,
  type ServerContext,
  Type,
} from "@pipoca/plugins";
import {
  person,
  type PluginTest,
  testPlugin,
  testSession,
} from "@pipoca/testing";
import type { RoutineDraft } from "./making";
import type { RoutineDetail, Run } from "./model";
import { server } from "./server";
import { session as sessionPart } from "./session";

const people = [
  { id: "ana", name: "Ana", admin: true },
  { id: "bo", name: "Bo" },
];

const tracker = definePlugin({
  id: "tracker",
  title: "Tracker",
  description: "Publishes merges.",
  works: ["personal", "team"],
  events: {
    merged: event({
      title: "A pull request merged",
      fields: Type.Object({ repository: Type.String() }),
    }),
  },
});

const subagents = definePlugin({
  id: "subagents",
  title: "Subagents",
  description: "Finds agents.",
});

let tracking: ServerContext<typeof tracker> | undefined;

const trackerServer = defineServer(tracker, (context) => {
  tracking = context;
});

async function started(): Promise<PluginTest> {
  return testPlugin(server, { people, plugins: [trackerServer, subagents] });
}

async function environment(t: PluginTest, owner: Owner = person("ana")) {
  return t.session({ owner, ...(owner === "team" && { startedBy: "ana" }) });
}

const docs = {
  title: "Docs from merges",
  when: [
    {
      kind: "event",
      event: "tracker.merged",
      where: [{ field: "repository", oneOf: ["acme/shop", "acme/api"] }],
    },
  ],
  do: {
    kind: "session",
    prompt: "Update the docs to match the merged pull request.",
    workspace: { kind: "clone", repository: "https://github.com/acme/docs" },
  },
};

const sentence =
  "When a pull request merges in shop or api, update the docs in docs-site";

test("a sentence is drafted into a routine by a short Session, which is told what doesn't fit until it does", async () => {
  await using t = await started();
  await environment(t);

  const asked = await t
    .as("ana")
    .post<RoutineDraft>("drafts", { sentence, timeZone: "Europe/Berlin" });

  expect(asked).toMatchObject({ sentence, state: "drafting" });

  const drafting = tracking?.sessions.get(asked.sessionId ?? "");

  expect(drafting?.firstMessage).toBe(sentence);
  expect(drafting?.systemPrompt).toContain("tracker.merged");
  expect(drafting?.systemPrompt).toContain("Europe/Berlin");

  const session = await t.attach(asked.sessionId ?? "");

  const misfit = await t.tool(
    "draft_routine",
    {
      name: "docs-from-merges",
      routine: { ...docs, when: [{ kind: "event", event: "tracker.closed" }] },
      summary: "Updates the docs when shop or api merges.",
    },
    { session },
  );

  expect(misfit).toEqual({
    text: "when.0: no event tracker.closed. Fix it and call draft_routine again.",
    isError: true,
  });

  const done = await t.tool(
    "draft_routine",
    {
      name: "docs-from-merges",
      routine: docs,
      summary: "Updates the docs when shop or api merges.",
    },
    { session },
  );

  expect(done).toMatchObject({ isError: false });

  expect(
    await t.as("ana").get<RoutineDraft>(`drafts/${asked.id}`),
  ).toMatchObject({
    state: "ready",
    name: "docs-from-merges",
    routine: docs,
    summary: "Updates the docs when shop or api merges.",
  });

  expect(t.as("bo").get(`drafts/${asked.id}`)).rejects.toThrow("no draft");

  await session.turn([]);

  expect(tracking?.sessions.get(session.id)?.archivedAt).not.toBeNull();
});

test("a draft that still doesn't fit after its tries comes back with why, and one never drafted fails", async () => {
  await using t = await started();
  await environment(t, "team");

  const asked = await t
    .as("ana")
    .post<RoutineDraft>("team/drafts", { sentence });

  const session = await t.attach(asked.sessionId ?? "");

  const message = {
    ...docs,
    do: { kind: "message", prompt: "Docs.", session: "s1" },
  };

  for (const answer of [true, true, false]) {
    expect(
      (
        await t.tool(
          "draft_routine",
          { name: "docs", routine: message, summary: "Docs." },
          { session },
        )
      ).isError,
    ).toBe(answer);
  }

  expect(
    await t.as("ana").get<RoutineDraft>(`team/drafts/${asked.id}`),
  ).toMatchObject({
    state: "ready",
    routine: message,
    error: "a team routine starts a Session of its own each time",
  });

  const silent = await t
    .as("ana")
    .post<RoutineDraft>("team/drafts", { sentence: "Hm." });

  await (await t.attach(silent.sessionId ?? "")).turn([]);

  expect(
    await t.as("ana").get<RoutineDraft>(`team/drafts/${silent.id}`),
  ).toMatchObject({ state: "failed" });
});

test("the Team assistant makes the team's routines, asking first", async () => {
  await using t = await started();
  const team = await environment(t, "team");

  const create = {
    action: "create",
    name: "docs",
    routine: docs,
    summary: "Updates the docs when shop or api merges.",
  };

  expect(
    await t.tool("routines", create, { session: team, answer: "deny" }),
  ).toEqual({ text: "The person said no.", isError: true });

  const made = await t.tool("routines", create, {
    session: team,
    answer: "allow",
  });

  expect(made.text).toContain("Created the routine docs");

  expect(
    (await t.as("ana").get<RoutineDetail>("team/routines/docs")).title,
  ).toBe("Docs from merges");

  expect(await t.as("ana").get("routines")).toEqual([]);
});

test("/routine runs the chat owner's routine with its inputs, and a run's Session can't", async () => {
  await using t = await started();
  const own = await environment(t);

  await t.as("ana").put("routines/tidy", {
    title: "Tidy",
    when: [{ kind: "webhook" }],
    inputs: { focus: { type: "string" }, depth: { type: "number" } },
    do: {
      kind: "session",
      prompt: "Tidy {{inputs.focus}} to {{inputs.depth}}.",
      workspace: { kind: "folder", path: "/srv/a" },
    },
  });

  const part = await testSession(sessionPart, { request: own.api.raw });

  const said = async (args: string) =>
    (await part.command("routine", args)) as readonly {
      readonly content: string;
      readonly details: { readonly data: unknown };
    }[];

  expect(await said('tidy focus="the docs" depth=2')).toMatchObject([
    { content: "Started tidy.", details: { data: { title: "Tidy" } } },
  ]);

  const [run] = (await t.as("ana").get<RoutineDetail>("routines/tidy")).runs;

  expect(tracking?.sessions.get(run?.sessionId ?? "")?.firstMessage).toBe(
    "Tidy the docs to 2.",
  );

  expect(await said("tidy depth=deep")).toMatchObject([
    { content: "tidy didn't start: inputs.depth must be a number" },
  ]);

  const [usage] = await said("tidy loose");

  expect(usage?.content).toContain("/routine <name> key=value");

  const inRun = await t.attach(run?.sessionId ?? "");

  expect(
    inRun.api.post<Run>("invoke", { name: "tidy", inputs: {} }),
  ).rejects.toThrow("a routine's own run can't start a routine");
});
