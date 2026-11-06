import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Config,
  definePlugin,
  defineServer,
  Secret,
  Type,
} from "@pipoca/plugins";
import type { Environment, PluginInfo, Session } from "@pipoca/protocol";
import { until } from "@pipoca/testing/until";
import { json, testServer, type TestServer } from "./testdata/harness";
import { runnerCredentials } from "./testdata/runners";

let root: string;
let server: TestServer;

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

const text = Type.Object({ text: Type.String() });

const ledger = defineServer(
  definePlugin({
    id: "ledger",
    title: "Ledger",
    description: "Keeps entries.",
    schema:
      "create table ledger_entries (id text primary key, text text not null) strict;",
    config: Config.object({
      limit: Config.number({ title: "Limit", default: 5 }),
      token: Type.Optional(Secret()),
      books: Config.collection({
        key: "name",
        title: "Books",
        item: Type.Object({ name: Type.String(), key: Secret() }),
      }),
    }),
  }),
  ({
    routes,
    store,
    config,
    sessions,
    schedule,
    secrets,
    environments,
    clock,
  }) => {
    const heard: unknown[] = [];
    const fired: unknown[] = [];

    config.watch((next, previous) => {
      heard.push({ next: next.limit, previous: previous.limit });
    });

    schedule.on("remind:", (payload) => {
      fired.push(payload);
    });

    routes.post("entries", { auth: "person", body: text }, ({ body }) =>
      store.run(
        "insert into ledger_entries (id, text) values (?, ?)",
        body.text,
        body.text,
      ),
    );

    routes.get("entries/:id", { auth: "person" }, ({ params }) => ({
      one:
        store.get("select text from ledger_entries where id = ?", params.id) ??
        null,
      all: store.all("select text from ledger_entries order by id"),
    }));

    routes.get("config", { auth: "person" }, () => config.get());

    routes.put(
      "config",
      {
        auth: "admin",
        body: Type.Object({ limit: Type.Number(), token: Type.String() }),
      },
      ({ body }) => {
        config.set(body);

        return config.get();
      },
    );

    routes.put(
      "books/:name",
      { auth: "admin", body: Type.Object({ key: Type.String() }) },
      ({ params, body }) => {
        config.collection("books").put({ name: params.name, key: body.key });

        return config.collection("books").list();
      },
    );

    routes.delete("books/:name", { auth: "admin" }, ({ params }) => ({
      removed: config.collection("books").remove(params.name),
    }));

    routes.get("watched", { auth: "person" }, () => heard);

    routes.post(
      "sessions/:id/notes",
      { auth: "person", body: text },
      ({ params, body }) => ({
        sent: sessions.send(params.id, {
          text: body.text,
          turn: false,
        }),
      }),
    );

    routes.post("reminders", { auth: "person", body: text }, ({ body }) => {
      schedule.at("remind:1", clock.now() + 60_000, body.text);

      return { pending: schedule.pending("remind:").length };
    });

    routes.get("reminders", { auth: "person" }, () => fired);

    routes.get("secrets", { auth: "person" }, () => {
      const sealed = secrets.seal("ledger_entries", "1", "hush");

      return {
        opened: secrets.open("ledger_entries", "1", sealed),
        moved: (() => {
          try {
            return secrets.open("ledger_entries", "2", sealed);
          } catch {
            return "refused";
          }
        })(),
      };
    });

    routes.get("machines", { auth: "person" }, () => ({
      environments: environments.list().map(({ name }) => name),
    }));
  },
);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "server-context-"));

  server = testServer({
    configDir: join(root, "config"),
    runners: { pollWaitMs: 0 },
    servers: [ledger],
  });
});

const api = async (
  path: string,
  init?: Parameters<TestServer["api"]>[1],
): Promise<unknown> =>
  json<unknown>(server.api(`/api/ext/ledger/${path}`, init));

test("keeps rows in the plugin's own tables", async () => {
  expect(await api("entries", { body: { text: "a" } })).toEqual({ changes: 1 });
  await api("entries", { body: { text: "b" } });

  expect(await api("entries/b")).toEqual({
    one: { text: "b" },
    all: [{ text: "a" }, { text: "b" }],
  });

  expect(await api("entries/c")).toMatchObject({ one: null });
});

test("reads config with defaults, seals a secret it is given, and hears its changes", async () => {
  expect(await api("config")).toEqual({ limit: 5, books: [] });

  expect(
    await api("config", { method: "PUT", body: { limit: 7, token: "hush" } }),
  ).toEqual({ limit: 7, token: "hush", books: [] });

  const file = await readFile(join(root, "config", "pipoca.json"), "utf8");

  expect(file).not.toContain("hush");
  expect(file).toContain("sealed");

  const written = JSON.parse(file) as Record<string, Record<string, unknown>>;

  await writeFile(
    join(root, "config", "pipoca.json"),
    JSON.stringify({ ledger: { ...written["ledger"], limit: 9 } }),
  );

  await server.clock.advance(2000);

  expect(await api("watched")).toEqual([
    { next: 7, previous: 5 },
    { next: 9, previous: 7 },
  ]);
});

test("puts and removes the items of a config collection by key", async () => {
  await api("books/red", { method: "PUT", body: { key: "one" } });

  expect(
    await api("books/red", { method: "PUT", body: { key: "two" } }),
  ).toEqual([{ name: "red", key: "two" }]);

  expect(await api("books/red", { method: "DELETE" })).toEqual({
    removed: true,
  });

  expect(await api("books/red", { method: "DELETE" })).toEqual({
    removed: false,
  });
});

test("sends a Session context, and says when the Session is gone", async () => {
  await runnerCredentials(server, server.signedIn).token("laptop");

  const [environment] = await json<Environment[]>(
    server.api("/api/environments"),
  );

  const session = await json<Session>(
    server.api("/api/sessions", {
      body: {
        environment: environment?.id,
        workspace: { kind: "folder", path: root },
      },
    }),
  );

  expect(
    await api(`sessions/${session.id}/notes`, { body: { text: "FYI" } }),
  ).toEqual({ sent: "queued" });

  expect(await api("sessions/nobody/notes", { body: { text: "FYI" } })).toEqual(
    { sent: "gone" },
  );
});

test("fires what it scheduled on the server's clock", async () => {
  expect(await api("reminders", { body: { text: "pay" } })).toEqual({
    pending: 1,
  });

  await server.clock.advance(60_000);

  expect(await api("reminders")).toEqual(["pay"]);
});

test("seals secrets for a row that only that row opens", async () => {
  expect(await api("secrets")).toEqual({
    opened: "hush",
    moved: "refused",
  });
});

test("reads the Environments", async () => {
  await runnerCredentials(server, server.signedIn).token("laptop");

  expect(await api("machines")).toEqual({
    environments: expect.arrayContaining(["laptop"]) as unknown,
  });
});

const gate = (id: string) =>
  defineServer(
    definePlugin({ id, title: id, description: "Signs people in." }),
    ({ provide }) => {
      provide.signIn({
        logins: () => [{ label: `Sign in with ${id}`, path: "go" }],
      });
    },
  );

test("lets one plugin sign people in, and fails another that tries too", async () => {
  const signing = testServer({
    builtIns: false,
    servers: [gate("gate"), gate("door")],
  });

  const status = await json<{ logins: unknown }>(signing.api("/api/auth"));
  const listed = await json<PluginInfo[]>(signing.api("/api/plugins"));

  await signing.close();

  expect(status.logins).toEqual([
    { label: "Sign in with gate", path: "/api/ext/gate/go" },
  ]);

  expect(listed.find(({ id }) => id === "door")).toMatchObject({
    state: "failed",
    error: "gate already signs people in",
  });
});

const keeper = (id: string) =>
  defineServer(
    definePlugin({
      id,
      title: id,
      description: "Keeps model logins.",
      modelCredentials: true,
    }),
    () => undefined,
  );

test("lets one plugin keep model logins, and fails another that says it does too", async () => {
  const keeping = testServer({
    builtIns: false,
    servers: [keeper("vault"), keeper("safe")],
  });

  const listed = await json<PluginInfo[]>(keeping.api("/api/plugins"));

  await keeping.close();

  expect(listed.find(({ id }) => id === "vault")).toMatchObject({
    state: "on",
    provides: ["modelCredentials"],
  });

  expect(listed.find(({ id }) => id === "safe")).toMatchObject({
    state: "failed",
    error: "vault already keeps model logins",
  });
});

// A plugin that fails later, out of an async listener, watcher or timer,
// costs only a log line under its name, not the server (spec 2.8a).
test("logs a plugin's async listener, config watcher and timer that reject", async () => {
  const flaky = testServer({
    configDir: join(root, "flaky"),
    servers: [
      defineServer(
        definePlugin({
          id: "flaky",
          title: "Flaky",
          description: "Fails late.",
          config: Config.object({
            limit: Config.number({ title: "Limit", default: 1 }),
          }),
        }),
        ({ events, config, timer }) => {
          events.on("PersonInvited", async () => {
            await Promise.resolve();
            throw new Error("listener broke");
          });

          config.watch(async () => {
            await Promise.resolve();
            throw new Error("watcher broke");
          });

          timer.after(60_000, async () => {
            await Promise.resolve();
            throw new Error("timer broke");
          });
        },
      ),
    ],
  });

  await flaky.api("/api/invites", { body: { emails: ["ana@example.com"] } });

  await flaky.api("/api/plugins/flaky/config", {
    method: "PUT",
    body: { value: { limit: 2 } },
  });

  await flaky.clock.advance(60_000);

  const failures = await until(
    () =>
      flaky.logs.filter(
        (line) => line.includes('"plugin":"flaky"') && line.includes("broke"),
      ),
    (lines) => lines.length === 3,
  );

  await flaky.close();

  expect(
    failures.map((line) => /broke/.exec(line) && line.split(" {")[0]),
  ).toEqual(["event listener failed", "config watcher failed", "timer failed"]);
});

test("turns a plugin on by default on a team server as its definition says", async () => {
  const team = testServer({
    builtIns: false,
    definitions: (["always", "solo", "team", "never"] as const).map(
      (defaultOn) =>
        definePlugin({
          id: `by-${defaultOn}`,
          title: defaultOn,
          description: "",
          defaultOn,
        }),
    ),
  });

  const listed = await json<PluginInfo[]>(team.api("/api/plugins"));

  await team.close();

  expect(listed.map(({ id, state }) => ({ id, state }))).toEqual([
    { id: "by-always", state: "on" },
    { id: "by-solo", state: "off" },
    { id: "by-team", state: "on" },
    { id: "by-never", state: "off" },
  ]);
});
