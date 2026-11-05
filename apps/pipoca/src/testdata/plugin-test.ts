import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  eventBus,
  owners,
  pluginClient,
  type PluginDefinition,
  type ServerContext,
  type ServerPart,
  type TypedBus,
} from "@pipoca/plugins";
import {
  type Duration,
  type PluginTest,
  type TestPluginOptions,
  type TestSession,
  until,
} from "@pipoca/plugins/testing";
import {
  type Command,
  type Method,
  protocolVersion,
  readSse,
  type ToolSpec,
  versionHeader,
  type Work,
} from "@pipoca/protocol";
import { changeFeed } from "../changes";
import { openStore } from "../sqlite/store";
import { testClock, testServer, type TestServer } from "./harness";

const password = "correct horse";
const longest = 2 ** 31 - 1;
const day = 24 * 60 * 60_000;

const units = { s: 1000, m: 60_000, h: 60 * 60_000, d: day } as const;

type Emitted = Parameters<TypedBus["emit"]>[0];

type Delivered = ReturnType<TestSession["delivered"]>[number];

interface Host {
  readonly id: string;
  readonly token: string;
  readonly commands: Command[];
  generation: number;
  stream: AbortController | undefined;
}

interface Opened {
  readonly origin: () => string;
  readonly fetch: TestPluginOptions["fetch"];
}

const realFetch = globalThis.fetch;
const opened = new Set<Opened>();

// Requests to a test's own server go out; any other is the plugins' and
// goes to the newest test's fetch.
const outbound = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);

    const { origin } = new URL(request.url);

    if ([...opened].some((each) => each.origin() === origin)) {
      return realFetch(request);
    }

    const answer = [...opened].at(-1)?.fetch;

    if (answer === undefined) {
      throw new Error(
        `no fetch answers ${request.method} ${request.url}; pass fetch to testPlugin`,
      );
    }

    return answer(request);
  },
  { preconnect: realFetch.preconnect },
);

export async function pluginTest(
  plugin: PluginDefinition,
  o: TestPluginOptions,
): Promise<PluginTest> {
  const root = await mkdtemp(join(tmpdir(), "plugin-test-"));
  const database = join(root, "server.db");
  const configDir = join(root, "config");
  const people = o.people ?? [];
  const clock = testClock();

  const definitions = [plugin, ...(o.plugins ?? [])];
  const contexts = new Map<string, ServerContext>();

  await mkdir(configDir);

  await writeFile(
    join(configDir, "pipoca.json"),
    JSON.stringify({
      ...(o.config !== undefined && { [plugin.id]: o.config }),
      plugins: Object.fromEntries(
        definitions.map(({ id }) => [id, { personal: true }]),
      ),
    }),
  );

  const seeded = openStore(database);
  const passwordHash = await Bun.password.hash(password);

  for (const { id, name = id, admin = false } of people) {
    seeded.people.insertUser({
      id,
      name,
      admin,
      passwordHash,
      createdAt: new Date(clock.now()).toISOString(),
    });
  }

  seeded.close();

  const log: { message: string; fields?: unknown }[] = [];
  const emitted: Emitted[] = [];
  const topics: string[] = [];

  const bus = eventBus((type, error) => {
    log.push({
      message: "event listener failed",
      fields: { type, error: String(error) },
    });
  });

  const events: TypedBus = {
    ...bus,
    emit: (event) => {
      emitted.push(event);
      bus.emit(event);
    },
  };

  const feed = changeFeed();

  const changes = {
    ...feed,
    publish: (topic: string) => {
      topics.push(topic);
      feed.publish(topic);
    },
  };

  const captured = definitions.map((definition): PluginDefinition => {
    const own: PluginDefinition = {
      ...definition,
      server: async () => {
        const part = (await definition.server?.())?.default as
          ServerPart | undefined;

        if (part !== undefined && part.plugin !== definition) {
          throw new Error(
            `the server part of ${definition.id} isn't one defineServer made for it`,
          );
        }

        return {
          default: {
            plugin: own,
            register: async (context: ServerContext) => {
              contexts.set(definition.id, context);
              await part?.register(context);
            },
          },
        };
      },
    };

    return own;
  });

  const [soloPerson] = people;

  const start = (): TestServer =>
    testServer({
      database,
      configDir,
      clock,
      runners: { pollWaitMs: 0, offlineAfterMs: longest, leaseMs: longest },
      plugins: [],
      definitions: captured,
      events,
      changes,
      ...(o.solo === true &&
        soloPerson !== undefined && {
          solo: {
            name: soloPerson.name ?? soloPerson.id,
            socket: join(root, "solo.sock"),
          },
        }),
      log: (message, fields) => {
        log.push({ message, ...(fields !== undefined && { fields }) });
      },
    });

  let server = start();

  const url = (path: string): URL => new URL(path, server.url);

  const self: Opened = { origin: () => server.url.origin, fetch: o.fetch };
  opened.add(self);
  globalThis.fetch = outbound;

  const ready = async (): Promise<void> => {
    await fetch(url("/healthz"));

    const failed = log.find(
      ({ message, fields }) =>
        message === "plugin failed to register" &&
        (fields as { plugin?: string }).plugin === plugin.id,
    );

    if (failed !== undefined) {
      throw new Error(
        `${plugin.id} failed to register: ${String((failed.fields as { error?: string }).error)}`,
      );
    }
  };

  const contextOf = (id: string): ServerContext => {
    const found = contexts.get(id);

    if (found === undefined) {
      throw new Error(`${id} isn't running on this test's server`);
    }

    return found;
  };

  const cookies = new Map<string, Promise<string>>();

  const signIn = async (name: string): Promise<string> => {
    const response = await fetch(url("/api/auth/session"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, password }),
    });

    const cookie = response.headers.get("set-cookie")?.split(";")[0];

    if (!response.ok || cookie === undefined) {
      throw new Error(`${name} can't sign in: ${String(response.status)}`);
    }

    return cookie;
  };

  const cookieOf = async (id: string): Promise<string> => {
    const found = people.find((each) => each.id === id);

    if (found === undefined) {
      throw new Error(`${id} isn't one of the test's people`);
    }

    const cookie = cookies.get(id) ?? signIn(found.name ?? found.id);
    cookies.set(id, cookie);

    return cookie;
  };

  const request = async (
    path: string,
    init: RequestInit,
    cookie?: string,
  ): Promise<Response> => {
    const headers = new Headers(init.headers);

    if (cookie !== undefined) {
      headers.set("cookie", cookie);
    }

    return fetch(url(path), { redirect: "manual", ...init, headers });
  };

  const json = async <T>(response: Promise<Response>): Promise<T> => {
    const answered = await response;

    if (!answered.ok) {
      throw new Error(
        `${answered.url} answered ${String(answered.status)}: ${await answered.text()}`,
      );
    }

    return (await answered.json()) as T;
  };

  const extPath = (path: string): string =>
    `/api/ext/${plugin.id}/${path.replace(/^\//, "")}`;

  const runner = (token: string, body?: unknown): RequestInit => ({
    method: body === undefined ? "GET" : "POST",
    headers: {
      [versionHeader]: String(protocolVersion),
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

  const hosts = new Map<string, Host>();

  const poll = async (
    host: Host,
    running: readonly { sessionId: string; generation: number }[],
  ): Promise<Work> =>
    json<Work>(
      request(
        "/runner/work",
        runner(host.token, { running, folders: [], models: [] }),
      ),
    );

  const attach = async (host: Host): Promise<void> => {
    const stream = new AbortController();

    const response = await request(
      `/runner/sessions/${host.id}/commands?generation=${String(host.generation)}`,
      { ...runner(host.token), signal: stream.signal },
    );

    if (!response.ok) {
      throw new Error(
        `the Session's commands answered ${String(response.status)}`,
      );
    }

    host.stream = stream;

    void (async () => {
      try {
        for await (const command of readSse(response, longest)) {
          host.commands.push(command as Command);
        }
      } catch {
        // The host went away.
      }
    })();
  };

  // A poll that runs nothing ends the Session's current attempt, as when
  // its runner restarts, and takes it again in a new one.
  const connect = async (host: Host): Promise<void> => {
    const { start: assigned } = await poll(host, []);
    const found = assigned.find(({ sessionId }) => sessionId === host.id);

    if (found === undefined) {
      throw new Error(`no runner took Session ${host.id}`);
    }

    host.generation = found.generation;
    await attach(host);
  };

  const disconnect = async (host: Host): Promise<void> => {
    await poll(host, []);
    host.stream?.abort();
    host.stream = undefined;
  };

  const keepUp = async (): Promise<void> => {
    for (const host of hosts.values()) {
      if (host.stream !== undefined) {
        await poll(host, [{ sessionId: host.id, generation: host.generation }]);
      }
    }
  };

  const outbox = new DatabaseSync(database, { readOnly: true });

  const queuedText = outbox.prepare(
    "select text from session_outbox where session_id = ? and text is not null order by id",
  );

  const adminId = (): string => {
    const found = people.find(({ admin }) => admin === true);

    if (found === undefined) {
      throw new Error("team work needs an admin among the test's people");
    }

    return found.id;
  };

  let teamProfile: Promise<string> | undefined;

  const teamProfileOf = async (): Promise<string> => {
    teamProfile ??= cookieOf(adminId()).then(async (cookie) => {
      const { id } = await json<{ id: string }>(
        request(
          "/api/profiles",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "Team work", team: true }),
          },
          cookie,
        ),
      );

      return id;
    });

    return teamProfile;
  };

  const hostOf = (session: TestSession): Host => {
    const found = hosts.get(session.id);

    if (found === undefined) {
      throw new Error(`Session ${session.id} isn't this test's`);
    }

    return found;
  };

  let calls = 0;

  await ready();

  return {
    as: (personId) => {
      const raw = async (
        method: Method,
        path: string,
        init: RequestInit = {},
      ): Promise<Response> =>
        request(extPath(path), { ...init, method }, await cookieOf(personId));

      return {
        ...pluginClient(plugin, {
          fetch: async (path, init) =>
            request(path, init, await cookieOf(personId)),
        }),
        raw,
      };
    },
    public: () => ({
      raw: async (method, path, init = {}) =>
        request(extPath(path), { ...init, method }),
      webhook: async (path, body, secret) =>
        request(extPath(path), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-pipoca-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
          },
          body,
        }),
    }),
    session: async ({ owner, startedBy, key, plugin: by = plugin.id }) => {
      const personal = owners.personId(owner);

      if (
        personal !== undefined &&
        startedBy !== undefined &&
        startedBy !== personal
      ) {
        throw new Error("a person's own Session is one they started");
      }

      const starter = personal ?? startedBy;
      const cookie = await cookieOf(personal ?? adminId());

      const environment = await json<{ id: string; key: string }>(
        request(
          "/api/environments",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: `session-${String(hosts.size + 1)}`,
              ...(personal === undefined && { team: true }),
            }),
          },
          cookie,
        ),
      );

      const joined = await json<{ token: string }>(
        request("/runner/join", runner(environment.key, { name: "runner" })),
      );

      const started = contextOf(by).sessions.start({
        environment: environment.id,
        workspace: { kind: "folder", path: root },
        actor: starter === undefined ? `plugin:${by}` : `user:${starter}`,
        ...(key !== undefined && { key }),
        ...(personal === undefined && {
          team: true,
          profile: await teamProfileOf(),
        }),
      });

      const host: Host = {
        id: started.id,
        token: joined.token,
        commands: [],
        generation: 0,
        stream: undefined,
      };

      hosts.set(host.id, host);
      await connect(host);

      return {
        id: host.id,
        environmentId: environment.id,
        api: pluginClient(plugin, {
          session: host.id,
          headers: { authorization: `Bearer ${host.token}` },
          fetch: async (path, init) => request(path, init),
        }),
        online: async (on) => {
          if (on && host.stream === undefined) {
            await connect(host);
          }

          if (!on && host.stream !== undefined) {
            await disconnect(host);
          }
        },
        delivered: () =>
          host.commands.flatMap((command): Delivered[] => {
            if (command.type === "message") {
              return [{ text: command.text, turn: true }];
            }

            if (command.type === "context") {
              return [{ text: command.text, turn: false }];
            }

            if (command.type === "notice") {
              const { text, turn, notice } = command;

              return [{ text, turn, notice }];
            }

            return [];
          }),
        queued: () => queuedText.all(host.id) as { text: string }[],
        send: async (personId, text) => {
          const sent = await request(
            `/api/sessions/${host.id}/commands`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ type: "message", text }),
            },
            await cookieOf(personId),
          );

          if (!sent.ok) {
            throw new Error(
              `the message answered ${String(sent.status)}: ${await sent.text()}`,
            );
          }
        },
        transcript: async (lines) => {
          const { entries } = await json<{ entries: readonly string[] }>(
            request(
              `/runner/sessions/${host.id}/transcript`,
              runner(host.token),
            ),
          );

          await json(
            request(
              `/runner/sessions/${host.id}/transcript`,
              runner(host.token, {
                generation: host.generation,
                start: entries.length,
                lines: lines.map((line) => JSON.stringify(line)),
              }),
            ),
          );
        },
        archive: async () => {
          await json(
            request(
              `/api/sessions/${host.id}`,
              {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ archived: true }),
              },
              cookie,
            ),
          );
        },
      };
    },
    tool: async (name, input, { session, answer }) => {
      const host = hostOf(session);
      const generation = host.generation;

      if (host.stream === undefined) {
        throw new Error("the Session is offline");
      }

      const offered = await json<readonly ToolSpec[]>(
        request(
          `/runner/sessions/${host.id}/tools?generation=${String(generation)}`,
          runner(host.token),
        ),
      );

      if (!offered.some((each) => each.name === name)) {
        throw new Error(`${name} isn't offered in this Session`);
      }

      const { question } = await json<{ question: string | null }>(
        request(
          `/runner/sessions/${host.id}/tool-questions`,
          runner(host.token, { generation, name, input }),
        ),
      );

      if (question !== null && answer === undefined) {
        throw new Error(`${name} asks "${question}"; pass answer`);
      }

      if (question !== null && answer === "deny") {
        return { text: "The person said no.", isError: true };
      }

      calls += 1;
      const id = `call-${String(calls)}`;

      const sent = await request(
        `/runner/sessions/${host.id}/tool-calls`,
        runner(host.token, { generation, id, name, input }),
      );

      if (!sent.ok) {
        throw new Error(`the tool call answered ${String(sent.status)}`);
      }

      const answered = await until(() =>
        host.commands.find(
          (command) => command.type === "tool_result" && command.id === id,
        ),
      );

      if (answered?.type !== "tool_result") {
        throw new Error("not a tool result");
      }

      const { text, isError, details } = answered.result;

      return { text, isError, ...(details !== undefined && { details }) };
    },
    emit: (event) => {
      events.publish(event);
    },
    emitted: (type) =>
      emitted.flatMap((event) =>
        event.type === type ? [{ fields: event.fields, to: event.to }] : [],
      ),
    clock: {
      now: clock.now,
      advance: async (by: Duration) => {
        let left =
          typeof by === "number"
            ? by
            : Number(by.slice(0, -1)) * units[by.at(-1) as keyof typeof units];

        // Runners poll at least daily, so none goes offline on the way.
        do {
          const step = Math.min(left, day);

          await clock.advance(step);
          await keepUp();
          left -= step;
        } while (left > 0);
      },
    },
    restart: async () => {
      await server.close();

      for (const host of hosts.values()) {
        host.stream?.abort();
      }

      contexts.clear();
      server = start();
      await ready();

      for (const host of hosts.values()) {
        if (host.stream !== undefined) {
          await poll(host, [
            { sessionId: host.id, generation: host.generation },
          ]);

          await attach(host);
        }
      }
    },
    get store() {
      return contextOf(plugin.id).store;
    },
    topics,
    log,
    close: async () => {
      for (const host of hosts.values()) {
        host.stream?.abort();
      }

      await server.close();
      outbox.close();
      opened.delete(self);

      if (opened.size === 0) {
        globalThis.fetch = realFetch;
      }

      await rm(root, { recursive: true, force: true });
    },
  };
}
