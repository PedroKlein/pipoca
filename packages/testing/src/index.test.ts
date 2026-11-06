import { afterEach, expect, test } from "bun:test";
import {
  Config,
  definePlugin,
  defineServer,
  defineSession,
  event,
  type PluginDefinition,
  Type,
} from "@pipoca/plugins";
import {
  type PluginTest,
  person,
  testPlugin,
  testSession,
  until,
} from "./index";
import { emptyProfile } from "@pipoca/protocol";

const tests: PluginTest[] = [];

afterEach(async () => {
  await Promise.all(tests.splice(0).map(async (each) => each.close()));
});

async function started<P extends PluginDefinition>(
  ...args: Parameters<typeof testPlugin<P>>
): Promise<PluginTest> {
  const t = await testPlugin(...args);
  tests.push(t);

  return t;
}

const hour = 60 * 60_000;

// Reminds a Session an hour after it is asked to, and tells it at once that
// it will.
const reminders = defineServer(
  definePlugin({
    id: "reminders",
    title: "Reminders",
    description: "Reminds Sessions.",
    schema:
      "create table reminders_sent (session_id text not null, at integer not null) strict;",
  }),
  ({ routes, schedule, sessions, store, clock }) => {
    schedule.on("remind:", (payload) => {
      const sessionId = String(payload);

      store.run(
        "insert into reminders_sent values (?, ?)",
        sessionId,
        clock.now(),
      );

      sessions.send(sessionId, { text: "Time is up.", turn: true });
    });

    routes.post(
      "reminders",
      { auth: "person", body: Type.Object({ session: Type.String() }) },
      ({ body }) => {
        schedule.at(`remind:${body.session}`, clock.now() + hour, body.session);
        sessions.send(body.session, { text: "In an hour.", turn: false });

        return { ok: true };
      },
    );
  },
);

const people = [{ id: "ana", name: "Ana", admin: true }];

test("a route a person calls sends to their Session", async () => {
  const t = await started(reminders, { people });
  const session = await t.session({ owner: person("ana") });

  expect(await t.as("ana").post("reminders", { session: session.id })).toEqual({
    ok: true,
  });

  expect(
    await until(
      () => session.delivered(),
      (delivered) => delivered.length === 1,
    ),
  ).toEqual([{ text: "In an hour.", turn: false }]);
});

test("moving the clock fires what is scheduled at that time", async () => {
  const t = await started(reminders, { people });
  const session = await t.session({ owner: person("ana") });
  const startedAt = t.clock.now();

  await t.as("ana").post("reminders", { session: session.id });
  await t.clock.advance("59m");

  expect(t.store.all("select * from reminders_sent")).toEqual([]);

  await t.clock.advance("1m");

  const sent = t.store.all<{ session_id: string; at: number }>(
    "select * from reminders_sent",
  );

  expect(sent.map(({ session_id }) => session_id)).toEqual([session.id]);
  expect(sent[0]?.at).toBeGreaterThanOrEqual(startedAt + hour);
});

test("a restart keeps what waits for an offline Session, and what is scheduled", async () => {
  const t = await started(reminders, { people });
  const session = await t.session({ owner: person("ana") });

  await session.online(false);
  await t.as("ana").post("reminders", { session: session.id });
  await t.restart();

  expect(session.queued()).toEqual([{ text: "In an hour." }]);

  await t.clock.advance("1h");

  expect(session.queued()).toEqual([
    { text: "In an hour." },
    { text: "Time is up." },
  ]);

  expect(session.delivered()).toEqual([]);

  await session.online(true);

  expect(
    await until(
      () => session.delivered(),
      (delivered) => delivered.length === 2,
    ),
  ).toEqual([
    { text: "In an hour.", turn: false },
    { text: "Time is up.", turn: true },
  ]);

  expect(session.queued()).toEqual([]);
});

const notes = defineServer(
  definePlugin({ id: "notes", title: "Notes", description: "Notes once." }),
  ({ routes, sessions }) => {
    routes.post(
      "notes",
      {
        auth: "person",
        body: Type.Object({ session: Type.String(), key: Type.String() }),
      },
      ({ body }) => ({
        sent: sessions.send(body.session, {
          text: `About ${body.key}.`,
          turn: false,
          dedupe: body.key,
        }),
      }),
    );
  },
);

test("a repeat send with a dedupe key is a no-op also after the first was delivered", async () => {
  const t = await started(notes, { people });
  const session = await t.session({ owner: person("ana") });

  const note = async (key: string) =>
    t.as("ana").post("notes", { session: session.id, key });

  await note("pr-1");
  await until(() => session.delivered().length === 1);
  await t.restart();
  await note("pr-1");
  await note("pr-2");

  expect(
    await until(
      () => session.delivered(),
      (delivered) => delivered.length === 2,
    ),
  ).toEqual([
    { text: "About pr-1.", turn: false },
    { text: "About pr-2.", turn: false },
  ]);
});

const rung: string[] = [];

// Rings at a time a person picks.
const alarms = defineServer(
  definePlugin({ id: "alarms", title: "Alarms", description: "Rings." }),
  ({ routes, schedule, clock }) => {
    schedule.on("ring:", (_payload, key) => {
      rung.push(key);
    });

    routes.post("alarms", { auth: "person" }, () => {
      schedule.at("ring:soon", clock.now() + 100, undefined);

      return { ok: true };
    });
  },
);

test("an at that comes due across a restart fires once its plugin has started", async () => {
  const t = await started(alarms, { people });

  await t.as("ana").post("alarms", {});
  await t.restart();
  await t.clock.advance("1s");

  expect(rung).toEqual(["ring:soon"]);
});

// Says hello by the greeting in its config.
const greeter = defineServer(
  definePlugin({
    id: "greeter",
    title: "Greeter",
    description: "Greets.",
    config: Config.object({
      greeting: Config.string({ title: "Greeting", default: "Hello" }),
    }),
  }),
  ({ config, routes }) => {
    const heard: string[] = [];

    config.watch((next) => {
      heard.push(next.greeting);
    });

    routes.get("heard", { auth: "person" }, () => heard);
  },
);

test("a hand edit of the plugin's config reaches it", async () => {
  const t = await started(greeter, { people, config: { greeting: "Hi" } });

  await t.editConfig({ greeting: "Howdy" });
  await t.clock.advance("2s");

  expect(await t.as("ana").get("heard")).toEqual(["Howdy"]);
});

// Asks another server for the time.
const remote = defineServer(
  definePlugin({ id: "remote", title: "Remote", description: "Asks away." }),
  ({ routes }) => {
    routes.get("time", { auth: "person" }, async () => {
      const response = await fetch("https://time.example.com/now");

      return { time: await response.text() };
    });
  },
);

test("a plugin's request to another server that the test doesn't answer fails", async () => {
  const t = await started(remote, { people });

  expect((await t.as("ana").raw("time", { method: "GET" })).status).toBe(500);

  expect(JSON.stringify(t.log)).toContain(
    "no fetch answers GET https://time.example.com/now",
  );
});

test("the test's fetch answers a plugin's requests to other servers", async () => {
  const asked: string[] = [];

  const t = await started(remote, {
    people,
    fetch: (request) => {
      asked.push(request.url);

      return new Response("noon");
    },
  });

  expect(await t.as("ana").get("time")).toEqual({ time: "noon" });
  expect(asked).toEqual(["https://time.example.com/now"]);
});

const pinged = event({
  title: "Pinged",
  fields: Type.Object({ by: Type.String() }),
});

// A tool that asks first and tells whoever started the Session.
const pings = defineServer(
  definePlugin({
    id: "pings",
    title: "Pings",
    description: "Pings.",
    events: { pinged },
  }),
  ({ tools, events }) => {
    tools.define({
      name: "ping",
      description: "Pings whoever started the Session",
      params: Type.Object({ loud: Type.Boolean() }),
      asks: ({ loud }) => (loud ? "Ping loudly?" : undefined),
      run: ({ loud }, { owner, person: by }) => {
        events.emit("pinged", { by: by?.name ?? "nobody" }, { to: [owner] });

        return { text: loud ? "PING" : "ping", details: { loud } };
      },
    });
  },
);

// Counts the pings it hears from the other plugin.
const counts = defineServer(
  definePlugin({
    id: "counts",
    title: "Counts",
    description: "Counts pings.",
    schema: "create table counts_heard (by text not null) strict;",
  }),
  ({ events, store, routes }) => {
    events.on(pinged, ({ fields }) => {
      store.run("insert into counts_heard values (?)", fields.by);
    });

    routes.get("heard", { auth: "person" }, () =>
      store.all("select by from counts_heard"),
    );
  },
);

test("a plugin hears what another plugin on the same server emits", async () => {
  const t = await started(counts, { people, plugins: [pings] });
  const session = await t.session({ owner: person("ana") });

  expect(await t.tool("ping", { loud: false }, { session })).toEqual({
    text: "ping",
    isError: false,
    details: { loud: false },
  });

  expect(t.emitted("pings.pinged")).toEqual([
    { fields: { by: "Ana" }, to: ["person:ana"] },
  ]);

  expect(await t.as("ana").get("heard")).toEqual([{ by: "Ana" }]);
});

test("a tool that asks runs only when the person says yes", async () => {
  const t = await started(pings, { people });
  const session = await t.session({ owner: person("ana") });

  expect(
    await t.tool("ping", { loud: true }, { session, answer: "deny" }),
  ).toEqual({ text: "The person said no.", isError: true });

  expect(t.emitted("pings.pinged")).toEqual([]);

  expect(
    await t.tool("ping", { loud: true }, { session, answer: "allow" }),
  ).toMatchObject({ text: "PING", isError: false });
});

// A tool only team work gets, in the Sessions this plugin owns.
const huddles = defineServer(
  definePlugin({
    id: "huddles",
    title: "Huddles",
    description: "Huddles.",
  }),
  ({ tools, sessions }) => {
    tools.define({
      name: "huddle",
      description: "Calls a huddle",
      params: Type.Object({}),
      when: { owner: "team", ownSessions: true },
      run: (_input, { session }) =>
        `Huddle in ${String(sessions.owned("standup").some(({ id }) => id === session.id))}`,
    });
  },
);

test("a team Session the plugin owns gets its tools for team work", async () => {
  const t = await started(huddles, {
    people: [...people, { id: "bo", name: "Bo" }],
  });

  const own = await t.session({ owner: person("bo") });

  const team = await t.session({
    owner: "team",
    startedBy: "bo",
    key: "standup",
  });

  expect(t.tool("huddle", {}, { session: own })).rejects.toThrow(
    "huddle isn't offered in this Session",
  );

  expect(await t.tool("huddle", {}, { session: team })).toEqual({
    text: "Huddle in true",
    isError: false,
  });
});

test("a Session part's tools run against a stand-in for Pi", async () => {
  const counter = defineSession(
    definePlugin({ id: "counter", title: "Counter", description: "" }),
    (s) => {
      s.tools.define({
        name: "count",
        description: "Counts to n",
        params: Type.Object({ n: Type.Number() }),
        run: ({ n }) => {
          s.publish("count", { n });

          return `Counted to ${String(n)}.`;
        },
      });
    },
  );

  const published = new Map<string, unknown>();

  const session = await testSession(counter, {
    publish: (key, data) => {
      published.set(key, data);
    },
  });

  expect(await session.tool("count", { n: 3 })).toMatchObject({
    text: "Counted to 3.",
    isError: false,
  });

  expect(published.get("count")).toEqual({ n: 3 });
});

// A route with a team half, and a tool that runs it as the Session's person.
const tallies = defineServer(
  definePlugin({
    id: "tallies",
    title: "Tallies",
    description: "Tallies.",
  }),
  ({ provide, routes, sessions, tools }) => {
    const helper = provide.profile(
      "helper",
      { ...emptyProfile, name: "Helper" },
      { team: true, routeTools: true },
    );

    routes.post(
      "tally",
      {
        auth: "person",
        team: true,
        tool: { name: "tallies_add", description: "Adds a tally" },
      },
      ({ caller }) => ({ owner: caller.owner }),
    );

    routes.post(
      "start",
      {
        auth: "person",
        team: true,
        body: Type.Object({ environment: Type.String() }),
      },
      ({ caller, body }) => ({
        id: sessions.start({
          key: "tally",
          environment: body.environment,
          actor: `user:${caller.person.id}`,
          profile: helper,
          workspace: { kind: "folder", path: "/" },
          ...(caller.owner === "team" && { team: true }),
        }).id,
      }),
    );

    tools.define({
      name: "tally_through_call",
      description: "Adds a tally through tools.call",
      params: Type.Object({}),
      when: { ownSessions: true },
      run: async (_input, { session }) =>
        (await tools.call("tallies_add", {}, { session: session.id })).text,
    });
  },
);

test("a team Session's route tools reach the route's team half", async () => {
  const t = await started(tallies, { people });
  const environment = await t.environment({ owner: "team" });

  const { id } = await t
    .as("ana")
    .post<{ id: string }>("team/start", { environment: environment.id });

  const session = await t.attach(id);

  expect(await t.tool("tallies_add", {}, { session })).toMatchObject({
    text: expect.stringContaining('"owner":"team"') as unknown,
  });

  expect(await t.tool("tally_through_call", {}, { session })).toMatchObject({
    text: expect.stringContaining('"owner":"team"') as unknown,
  });
});
