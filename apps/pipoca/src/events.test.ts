import { afterEach, expect, test } from "bun:test";
import {
  definePlugin,
  defineServer,
  event,
  type ServerPlugin,
  Type,
} from "@pipoca/plugins";
import type { DeclaredEvent, PluginInfo } from "@pipoca/protocol";
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

const notes = definePlugin({
  id: "notes",
  title: "Notes",
  description: "Keeps notes.",
  events: { noted },
});

// Emits what its route is sent, to whom the route says, or publishes it as
// a v1 plugin does.
const notesServer = defineServer(notes, ({ routes, events }) => {
  routes.handle(async (request, path) => {
    const { text, to } = (await request.json()) as {
      text: unknown;
      to: readonly ("team" | `person:${string}`)[];
    };

    try {
      if (path === "v1") {
        events.publish({
          type: "notes.noted",
          text,
          userIds: to.map((owner) => owner.replace("person:", "")),
        });
      } else {
        events.emit("noted", { text } as { text: string }, { to });
      }
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }

    return new Response(null, { status: 204 });
  });
});

const v1Listener: ServerPlugin = {
  name: "old",
  register: ({ routes, events }) => {
    const heard: unknown[] = [];

    events.subscribe("notes.noted", (each) => {
      heard.push(each);
    });

    routes.handle(() => Response.json(heard));
  },
};

const v2Listener = defineServer(
  definePlugin({ id: "board", title: "Board", description: "Shows notes." }),
  ({ routes, events }) => {
    const heard: unknown[] = [];

    events.on(noted, ({ fields, to, plugin }) => {
      heard.push({ fields, to, plugin });
    });

    events.on("SessionCreated", ({ session, to }) => {
      heard.push({ ownedBy: session.ownedBy, to });
    });

    routes.handle(() => Response.json(heard));
  },
);

async function plugins(): Promise<PluginInfo[]> {
  return json<PluginInfo[]>(server.api("/api/plugins"));
}

test("refuses an event its plugin didn't define, or fields that don't fit it", async () => {
  server = testServer({
    plugins: [
      notesServer,
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

  const wrong = await server.api("/api/ext/notes/x", {
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

test("tells v1 listeners whose an event is as user ids, and v2 listeners as owners", async () => {
  server = testServer({
    plugins: [notesServer, v1Listener, v2Listener],
  });

  await server.api("/api/ext/notes/x", {
    body: { text: "hello", to: ["person:ana", "team"] },
  });

  await server.api("/api/ext/notes/x", { body: { text: "quiet", to: [] } });

  await server.api("/api/ext/notes/v1", {
    body: { text: "old", to: ["person:bo"] },
  });

  await runnerCredentials(server, server.signedIn).token("laptop");

  await server.api("/api/sessions", {
    body: { workspace: { kind: "folder", path: "/work" } },
  });

  expect(await json(server.api("/api/ext/old/x"))).toEqual([
    { type: "notes.noted", text: "hello", userIds: ["ana", "team"] },
    { type: "notes.noted", text: "quiet" },
    { type: "notes.noted", text: "old", userIds: ["bo"] },
  ]);

  const [hello, quiet, old, created] = await json<
    { fields?: unknown; plugin?: string; ownedBy?: string; to: string[] }[]
  >(server.api("/api/ext/board/x"));

  expect([hello, quiet, old]).toEqual([
    {
      fields: { text: "hello" },
      to: ["person:ana", "team"],
      plugin: "notes",
    },
    { fields: { text: "quiet" }, to: [], plugin: "notes" },
    { fields: { text: "old" }, to: ["person:bo"], plugin: "notes" },
  ]);

  expect(created?.ownedBy).toStartWith("person:");
  expect(created?.to).toEqual([created?.ownedBy ?? ""]);
});

test("hears another plugin's events while it is on, and keeps going while it is off", async () => {
  server = testServer({ plugins: [notesServer, v2Listener] });

  await server.api("/api/ext/notes/x", {
    body: { text: "hello", to: ["team"] },
  });

  expect(await json(server.api("/api/ext/board/x"))).toEqual([
    { fields: { text: "hello" }, to: ["team"], plugin: "notes" },
  ]);

  await server.close();

  server = testServer({
    plugins: [notesServer, v2Listener],
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
  const needing = (requires: string): ServerPlugin =>
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
    plugins: [
      needing("notes"),
      needing("broken"),
      notesServer,
      {
        name: "broken",
        register: () => {
          throw new Error("broken always fails");
        },
      },
      needing("board"),
    ],
    disabledPlugins: ["board"],
  });

  expect(
    (await plugins()).map(({ id, state, error }) => ({ id, state, error })),
  ).toEqual([
    { id: "needs-notes", state: "on", error: undefined },
    {
      id: "needs-broken",
      state: "failed",
      error: "needs-broken needs broken, which failed",
    },
    { id: "notes", state: "on", error: undefined },
    { id: "broken", state: "failed", error: "broken always fails" },
    {
      id: "needs-board",
      state: "failed",
      error: "needs-board needs board, which is off",
    },
  ]);
});

test("lists the events plugins define, and finds people", async () => {
  server = testServer({
    plugins: [
      notesServer,
      defineServer(
        definePlugin({ id: "lookup", title: "Lookup", description: "" }),
        ({ routes, events, people }) => {
          routes.handle((_request, path) =>
            Response.json(
              path === "events"
                ? events.declared()
                : {
                    first: people.list().map(({ name }) => name),
                    byName: people.byName(people.list()[0]?.name ?? "")?.id,
                    byId: people.get(people.list()[0]?.id ?? "")?.admin,
                    nobody: people.get("nobody") ?? null,
                  },
            ),
          );
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
