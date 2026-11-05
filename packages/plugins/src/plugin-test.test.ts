import { afterEach, expect, test } from "bun:test";
import {
  Config,
  definePlugin,
  event,
  type PluginDefinition,
} from "./definition";
import type { SessionPlugin } from "./plugin";
import { defineServer, type ServerContext } from "./server";
import {
  type PluginTest,
  person,
  testPlugin,
  testSession,
  until,
} from "./testing";
import { Type } from "typebox";

const tests: PluginTest[] = [];

afterEach(async () => {
  await Promise.all(tests.splice(0).map(async (each) => each.close()));
});

async function started(
  ...args: Parameters<typeof testPlugin>
): Promise<PluginTest> {
  const t = await testPlugin(...args);
  tests.push(t);

  return t;
}

function served<P extends PluginDefinition>(
  plugin: P,
  register: (context: ServerContext<P>) => void | Promise<void>,
): P {
  const definition: P = {
    ...plugin,
    server: async () =>
      Promise.resolve({ default: defineServer(definition, register) }),
  };

  return definition;
}

const hour = 60 * 60_000;

// Reminds a Session an hour after it is asked to, and tells it at once that
// it will.
const reminders = served(
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

let alarmBoots = 0;
const rung: string[] = [];

// Rings at a time a person picks, and takes a while to start after the first
// boot.
const alarms = served(
  definePlugin({ id: "alarms", title: "Alarms", description: "Rings." }),
  async ({ routes, schedule, clock }) => {
    alarmBoots += 1;

    if (alarmBoots > 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    schedule.on("ring:", (_payload, key) => {
      rung.push(key);
    });

    routes.post("alarms", { auth: "person" }, () => {
      schedule.at("ring:soon", clock.now() + 100, undefined);

      return { ok: true };
    });
  },
);

test("an at that comes due while its plugin starts fires once it has started", async () => {
  const t = await started(alarms, { people });

  await t.as("ana").post("alarms", {});
  await t.restart();

  expect(
    await until(
      () => rung,
      (each) => each.length > 0,
      3000,
    ),
  ).toEqual(["ring:soon"]);
});

// Says hello by the greeting in its config.
const greeter = served(
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
const remote = served(
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

  expect((await t.as("ana").raw("GET", "time")).status).toBe(500);

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
const pings = served(
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
const counts = served(
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
const huddles = served(
  definePlugin({
    id: "huddles",
    title: "Huddles",
    description: "Huddles.",
    works: ["personal", "team"],
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
  const counter: SessionPlugin = {
    name: "counter",
    extension: (cloud) => (pi) => {
      pi.registerTool({
        name: "count",
        label: "Count",
        description: "Counts to n",
        parameters: Type.Object({ n: Type.Number() }),
        execute: async (_id, { n }: { n: number }) => {
          cloud.publish("count", { n });

          return Promise.resolve({
            content: [{ type: "text", text: `Counted to ${String(n)}.` }],
            details: undefined,
          });
        },
      });
    },
  };

  const session = await testSession(counter);

  expect(await session.tool("count", { n: 3 })).toEqual({
    text: "Counted to 3.",
    isError: false,
  });

  expect(session.published("count")).toEqual({ n: 3 });
});
