import { afterEach, expect, test } from "bun:test";
import { definePlugin, defineServer, event, Type } from "@pipoca/plugins";
import type { ServerPart } from "@pipoca/plugins/host";
import type { DeclaredEvent, Owner, PluginInfo } from "@pipoca/protocol";
import {
  closeServers,
  json,
  testServer,
  type TestServer,
} from "./testdata/harness";
import { runnerCredentials } from "./testdata/runners";

let server: TestServer;

afterEach(closeServers);

const noted = event({
  title: "Note added",
  description: "Someone added a note.",
  fields: Type.Object({ text: Type.String() }),
});

const sent = Type.Object({
  text: Type.Unknown(),
  to: Type.Array(Type.Unsafe<Owner>(Type.String())),
});

// Emits what its route is sent, to whom the route says.
const notes = defineServer(
  definePlugin({
    id: "notes",
    title: "Notes",
    description: "Keeps notes.",
    events: { noted },
  }),
  ({ routes, events }) => {
    routes.post("notes", { auth: "person", body: sent }, ({ body }) => {
      try {
        events.emit("noted", { text: body.text } as { text: string }, {
          to: body.to,
        });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }

      return { emitted: true };
    });
  },
);

const board = defineServer(
  definePlugin({ id: "board", title: "Board", description: "Shows notes." }),
  ({ routes, events }) => {
    const heard: unknown[] = [];

    events.on(noted, ({ fields, to, plugin }) => {
      heard.push({ fields, to, plugin });
    });

    events.on("SessionCreated", ({ session, to }) => {
      heard.push({ ownedBy: session.ownedBy, to });
    });

    routes.get("heard", { auth: "person" }, () => heard);
  },
);

async function plugins(): Promise<PluginInfo[]> {
  return json<PluginInfo[]>(server.api("/api/plugins"));
}

test("refuses an event its plugin didn't define, or fields that don't fit it", async () => {
  server = testServer({
    builtIns: false,
    servers: [
      notes,
      defineServer(
        definePlugin({ id: "loud", title: "Loud", description: "" }),
        ({ events }) => {
          (events.emit as (name: string, fields: object, o: object) => void)(
            "shouted",
            {},
            { to: [] },
          );
        },
      ),
    ],
  });

  const wrong = await server.api("/api/ext/notes/notes", {
    body: { text: 3, to: [] },
  });

  expect(await wrong.json()).toEqual({
    error: "Error: notes.noted text must be string",
  });

  expect(
    (await plugins()).map(({ id, state, error }) => ({ id, state, error })),
  ).toEqual([
    { id: "notes", state: "on", error: undefined },
    { id: "loud", state: "failed", error: "loud defines no event shouted" },
  ]);
});

test("tells listeners whose an event is, as owners", async () => {
  server = testServer({ builtIns: false, servers: [notes, board] });

  await server.api("/api/ext/notes/notes", {
    body: { text: "hello", to: ["person:ana", "team"] },
  });

  await server.api("/api/ext/notes/notes", {
    body: { text: "quiet", to: [] },
  });

  await runnerCredentials(server, server.signedIn).token("laptop");

  await server.api("/api/sessions", {
    body: { workspace: { kind: "folder", path: "/work" } },
  });

  const [hello, quiet, created] = await json<
    { fields?: unknown; plugin?: string; ownedBy?: string; to: string[] }[]
  >(server.api("/api/ext/board/heard"));

  expect([hello, quiet]).toEqual([
    {
      fields: { text: "hello" },
      to: ["person:ana", "team"],
      plugin: "notes",
    },
    { fields: { text: "quiet" }, to: [], plugin: "notes" },
  ]);

  expect(created?.ownedBy).toStartWith("person:");
  expect(created?.to).toEqual([created?.ownedBy ?? ""]);
});

test("hears another plugin's events while it is on, and keeps going while it is off", async () => {
  server = testServer({ builtIns: false, servers: [notes, board] });

  await server.api("/api/ext/notes/notes", {
    body: { text: "hello", to: ["team"] },
  });

  expect(await json(server.api("/api/ext/board/heard"))).toEqual([
    { fields: { text: "hello" }, to: ["team"], plugin: "notes" },
  ]);

  await server.close();

  server = testServer({
    builtIns: false,
    servers: [notes, board],
    disabledPlugins: ["notes"],
  });

  expect(
    (await plugins()).map(({ id, state, error }) => ({ id, state, error })),
  ).toEqual([
    { id: "notes", state: "off", error: undefined },
    { id: "board", state: "on", error: undefined },
  ]);
});

test("keeps a plugin off while a plugin it requires is off or failed", async () => {
  const needing = (requires: string): ServerPart =>
    defineServer(
      definePlugin({
        id: `needs-${requires}`,
        title: "Needs",
        description: "",
        requires: { [requires]: "required" },
      }),
      () => undefined,
    );

  server = testServer({
    builtIns: false,
    servers: [
      defineServer(
        definePlugin({ id: "broken", title: "Broken", description: "" }),
        () => {
          throw new Error("broken always fails");
        },
      ),
      needing("notes"),
      needing("broken"),
      notes,
      needing("board"),
      board,
    ],
    disabledPlugins: ["board"],
  });

  expect(
    (await plugins()).map(({ id, state, error }) => ({ id, state, error })),
  ).toEqual([
    { id: "broken", state: "failed", error: "broken always fails" },
    { id: "needs-notes", state: "on", error: undefined },
    {
      id: "needs-broken",
      state: "failed",
      error: "needs-broken needs broken, which failed",
    },
    { id: "notes", state: "on", error: undefined },
    {
      id: "needs-board",
      state: "failed",
      error: "needs-board needs board, which is off",
    },
    { id: "board", state: "off", error: undefined },
  ]);
});

test("lists the events plugins define, and finds people", async () => {
  server = testServer({
    builtIns: false,
    servers: [
      notes,
      defineServer(
        definePlugin({ id: "lookup", title: "Lookup", description: "" }),
        ({ routes, events, people }) => {
          routes.get("events", { auth: "person" }, () => events.declared());

          routes.get("people", { auth: "person" }, () => ({
            first: people.list().map(({ name }) => name),
            byName: people.byName(people.list()[0]?.name ?? "")?.id,
            byId: people.get(people.list()[0]?.id ?? "")?.admin,
            nobody: people.get("nobody") ?? null,
          }));
        },
      ),
    ],
  });

  expect(
    await json<DeclaredEvent[]>(server.api("/api/ext/lookup/events")),
  ).toEqual([
    {
      type: "notes.noted",
      title: "Note added",
      description: "Someone added a note.",
      fields: {
        type: "object",
        required: ["text"],
        properties: { text: { type: "string" } },
      },
    },
  ]);

  const found = await json<{ first: string[]; byName: string }>(
    server.api("/api/ext/lookup/people"),
  );

  expect(found).toMatchObject({ byId: true, nobody: null });
  expect(found.first).toHaveLength(1);
  expect(found.byName).toBeString();
});

test("lists what a plugin's server part reaches of its context and what it provides", async () => {
  const offers = defineServer(
    definePlugin({ id: "offers", title: "Offers", description: "" }),
    ({ provide }) => {
      provide.models(() => ({ models: [] }));
    },
  );

  server = testServer({ builtIns: false, servers: [notes, board, offers] });

  expect(
    (await plugins()).map(({ id, uses, provides }) => ({ id, uses, provides })),
  ).toEqual([
    { id: "notes", uses: ["routes", "events"], provides: [] },
    { id: "board", uses: ["routes", "events"], provides: [] },
    { id: "offers", uses: ["provide"], provides: ["models"] },
  ]);
});
