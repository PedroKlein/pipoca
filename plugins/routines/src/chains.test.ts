import { expect, test } from "bun:test";
import {
  definePlugin,
  defineServer,
  type ServerContext,
} from "@pipoca/plugins";
import {
  person,
  type PluginTest,
  type TestSession,
  testPlugin,
} from "@pipoca/testing";
import type { RoutineDetail, Run } from "./model";
import { server } from "./server";

const people = [
  { id: "ana", name: "Ana", admin: true },
  { id: "bo", name: "Bo" },
];

const subagents = definePlugin({
  id: "subagents",
  title: "Subagents",
  description: "Finds agents.",
});

const watcher = definePlugin({
  id: "watcher",
  title: "Watcher",
  description: "Looks at the Sessions routines start.",
});

let watching: ServerContext<typeof watcher> | undefined;

const watcherServer = defineServer(watcher, (context) => {
  watching = context;
});

let hosts = new Map<string, TestSession>();
let teamProfile: string | undefined;

async function started(): Promise<PluginTest> {
  const t = await testPlugin(server, {
    people,
    plugins: [subagents, watcherServer],
  });

  hosts = new Map();
  await t.session({ owner: person("ana") });
  const team = await t.session({ owner: "team", startedBy: "ana" });
  teamProfile = watching?.sessions.get(team.id)?.profileId;

  return t;
}

const work = {
  kind: "session",
  prompt: "Do it.",
  workspace: { kind: "folder", path: "/srv/a" },
};

const byHand = [{ kind: "webhook" }];

function following(name: string, more: object[] = [], extra: object = {}) {
  return {
    kind: "event",
    event: "routines.run_ended",
    where: [{ field: "routine", is: name }, ...more],
    ...extra,
  };
}

async function detail(
  t: PluginTest,
  name: string,
  prefix = "",
  as = "ana",
): Promise<RoutineDetail> {
  return t.as(as).get<RoutineDetail>(`${prefix}routines/${name}`);
}

async function runs(t: PluginTest, name: string, prefix = "", as = "ana") {
  return (await detail(t, name, prefix, as)).runs;
}

async function host(t: PluginTest, run: Run | undefined): Promise<TestSession> {
  const id = run?.sessionId ?? "";
  const found = hosts.get(id) ?? (await t.attach(id));

  hosts.set(id, found);

  return found;
}

async function ends(
  t: PluginTest,
  run: Run | undefined,
  input: object,
): Promise<{ readonly text: string; readonly isError: boolean }> {
  return t.tool("end_run", input, { session: await host(t, run) });
}

async function failureOf(answer: Promise<unknown>): Promise<string> {
  try {
    await answer;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("it didn't fail");
}

test("a run that ends publishes its summary and output, and a routine that follows it runs one deeper with them", async () => {
  await using t = await started();

  await t.as("ana").put("routines/triage", {
    title: "Triage",
    when: byHand,
    output: { area: "string", ready: "boolean", labels: ["string"] },
    do: work,
  });

  await t.as("ana").put("routines/fix", {
    title: "Fix",
    when: [
      following("triage", [{ field: "output.ready", is: true }], {
        inputs: { area: "{{event.output.area}}" },
      }),
    ],
    inputs: { area: { type: "string" } },
    do: { ...work, prompt: "Fix {{inputs.area}}." },
  });

  expect(await detail(t, "triage")).toMatchObject({
    feeds: ["fix"],
    fedBy: [],
  });

  expect(await detail(t, "fix")).toMatchObject({
    feeds: [],
    fedBy: ["triage"],
  });

  const first = await t.as("ana").post<Run>("routines/triage/run", {});

  await ends(t, first, {
    result: "done",
    summary: "Not ready.",
    output: { area: "cart", ready: false, labels: [] },
  });

  await t.clock.advance("30s");
  expect(await runs(t, "fix")).toEqual([]);

  const second = await t.as("ana").post<Run>("routines/triage/run", {});

  await ends(t, second, {
    result: "done",
    summary: "The cart is broken.",
    output: { area: "cart", ready: true, labels: ["bug"] },
  });

  expect(t.emitted("routines.run_ended").at(-1)).toEqual({
    fields: {
      routine: "triage",
      title: "Triage",
      group: null,
      outcome: "ok",
      summary: "The cart is broken.",
      output: { area: "cart", ready: true, labels: ["bug"] },
      key: "",
      run: second.id,
      session: second.sessionId,
      depth: 0,
    },
    to: [person("ana")],
  });

  expect((await runs(t, "triage"))[0]).toMatchObject({
    output: { area: "cart", ready: true },
  });

  await t.clock.advance("30s");

  const [fix] = await runs(t, "fix");

  expect(fix).toMatchObject({ cause: "event", outcome: "running", depth: 1 });

  expect(
    watching?.sessions.get(fix?.sessionId ?? "")?.firstMessage,
  ).toStartWith("Fix <outside_input>cart</outside_input>.");
});

test("end_run refuses output that doesn't fit the fields the routine declares, and a routine that follows it names only those", async () => {
  await using t = await started();

  await t.as("ana").put("routines/triage", {
    title: "Triage",
    when: byHand,
    output: { area: "string", ready: "boolean" },
    do: work,
  });

  const run = await t.as("ana").post<Run>("routines/triage/run", {});

  expect(
    await ends(t, run, {
      result: "done",
      summary: "x",
      output: { area: "cart" },
    }),
  ).toEqual({ text: "output.ready must be a boolean", isError: true });

  expect(
    await ends(t, run, {
      result: "done",
      summary: "x",
      output: { area: "cart", ready: true, size: 3 },
    }),
  ).toEqual({ text: "the routine's output has no field size", isError: true });

  expect(
    await ends(t, run, { result: "done", summary: "x", output: undefined }),
  ).toMatchObject({ isError: true });

  // A run that did nothing may leave it out.
  expect(await ends(t, run, { result: "nothing", summary: "x" })).toEqual({
    text: "Noted. End your turn.",
    isError: false,
  });

  const follower = (where: object, source = "triage") => ({
    title: "Fix",
    when: [following(source, [where])],
    do: work,
  });

  expect(
    await failureOf(
      t
        .as("ana")
        .put("routines/fix", follower({ field: "output.size", is: 3 })),
    ),
  ).toBe("when.0.where.1: the event has no field output.size");

  expect(
    await failureOf(
      t
        .as("ana")
        .put("routines/fix", follower({ field: "output.ready", is: "yes" })),
    ),
  ).toBe('when.0.where.1: output.ready holds a boolean, not "yes"');

  await t
    .as("ana")
    .put("routines/fix", follower({ field: "output.area", is: "cart" }));

  // A routine that declares no output passes on whatever its runs give.
  await t.as("ana").put("routines/loose", {
    title: "Loose",
    when: byHand,
    do: work,
  });

  await t
    .as("ana")
    .put(
      "routines/after-loose",
      follower({ field: "output.anything", is: 1 }, "loose"),
    );

  const loose = await t.as("ana").post<Run>("routines/loose/run", {});

  expect(
    await ends(t, loose, {
      result: "done",
      summary: "x",
      output: { anything: 1 },
    }),
  ).toMatchObject({ isError: false });
});

test("a chain runs five deep, then skips its next run and tells its owner once", async () => {
  await using t = await started();

  await t.as("ana").put("routines/loop", {
    title: "Loop",
    when: [...byHand, following("loop")],
    do: work,
  });

  let run = await t.as("ana").post<Run>("routines/loop/run", {});

  for (const depth of [0, 1, 2, 3, 4, 5]) {
    expect(run).toMatchObject({ outcome: "running" });
    expect(run.depth).toBe(depth === 0 ? undefined : depth);

    await ends(t, run, { result: "done", summary: `at ${String(depth)}` });
    await t.clock.advance("30s");

    const [latest] = await runs(t, "loop");

    if (latest === undefined) {
      throw new Error("no run");
    }

    run = latest;
  }

  expect(run).toMatchObject({
    outcome: "skipped",
    reason: "it follows a chain of 5 runs, and a chain goes no deeper",
    depth: 6,
  });

  expect(t.emitted("routines.chain_stopped")).toEqual([
    {
      fields: {
        name: "loop",
        title: "Loop",
        reason:
          "A run of Loop was skipped: it follows a chain of 5 runs, and a chain goes no deeper. Look for routines that follow each other in a loop.",
      },
      to: [person("ana")],
    },
  ]);
});

test("a personal routine follows only its owner's routines, and a team routine only the team's", async () => {
  await using t = await started();

  await t.as("ana").put("routines/source", {
    title: "Source",
    when: byHand,
    do: work,
  });

  await t.as("ana").put("routines/mine", {
    title: "Mine",
    when: [following("source")],
    do: work,
  });

  await t.as("bo").put("routines/theirs", {
    title: "Theirs",
    when: [following("source")],
    do: work,
  });

  const team = { ...work, profile: teamProfile };

  await t.as("ana").put("team/routines/source", {
    title: "Team source",
    when: byHand,
    do: team,
  });

  await t.as("ana").put("team/routines/ours", {
    title: "Ours",
    when: [following("source")],
    do: team,
  });

  const run = await t.as("ana").post<Run>("routines/source/run", {});

  await ends(t, run, { result: "done", summary: "Done." });
  await t.clock.advance("30s");

  expect((await runs(t, "mine")).length).toBe(1);
  expect(await runs(t, "theirs", "", "bo")).toEqual([]);
  expect(await runs(t, "ours", "team/")).toEqual([]);

  const teams = await t.as("ana").post<Run>("team/routines/source/run", {});

  await ends(t, teams, { result: "done", summary: "Done." });
  await t.clock.advance("30s");

  expect((await runs(t, "ours", "team/")).length).toBe(1);
  expect((await runs(t, "mine")).length).toBe(1);
});
