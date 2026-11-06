import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  owners,
  type PluginDefinition,
  type ServerContext,
  type ServerPart,
} from "@pipoca/plugins";
import { eventBus, pluginClient, type TypedBus } from "@pipoca/plugins/host";
import { until } from "@pipoca/plugins/testing";
import type {
  Duration,
  PluginTest,
  TestPluginOptions,
  TestSession,
} from "@pipoca/testing";
import {
  type Command,
  type GitLogin,
  type Method,
  type Owner,
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
  gitLogins: readonly GitLogin[];
  stream: AbortController | undefined;
}

interface Opened {
  readonly fetch: TestPluginOptions["fetch"];
}

const realFetch = globalThis.fetch;
const opened = new Set<Opened>();

// Requests to this machine go out, such as to a test's own server or one
// another test left running; any other is the plugins' and goes to the
// newest test's fetch.
const outbound = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);

    if (["127.0.0.1", "localhost"].includes(new URL(request.url).hostname)) {
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
  tested: ServerPart | PluginDefinition,
  o: TestPluginOptions,
): Promise<PluginTest> {
  const root = await mkdtemp(join(tmpdir(), "plugin-test-"));
  const database = join(root, "server.db");
  const configDir = join(root, "config");
  const people = o.people ?? [];
  const clock = testClock({ frozen: true });

  const parts = [tested, ...(o.plugins ?? [])].map((each): ServerPart =>
    "register" in each ? each : { plugin: each, register: () => undefined },
  );

  const definitions = parts.map(({ plugin }) => plugin);
  const plugin = "register" in tested ? tested.plugin : tested;
  const contexts = new Map<string, ServerContext>();

  const configFile = join(configDir, "pipoca.json");

  await mkdir(configDir);

  await writeFile(
    configFile,
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

  const captured = parts.map((part): ServerPart => ({
    plugin: part.plugin,
    register: (context) => {
      contexts.set(part.plugin.id, context);
      part.register(context);
    },
  }));

  const [soloPerson] = people;

  const start = (): TestServer =>
    testServer({
      database,
      configDir,
      clock,
      runners: { pollWaitMs: 0, offlineAfterMs: longest, leaseMs: longest },
      plugins: [],
      servers: captured,
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

  // Before the server starts, since its plugins register as it does.
  const self: Opened = { fetch: o.fetch };
  opened.add(self);
  globalThis.fetch = outbound;

  let server = start();

  const url = (path: string): URL => new URL(path, server.url);

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

  // What the runner a token is for runs: every connected host of it but the
  // one left out.
  const runningOn = (
    token: string,
    without?: Host,
  ): { sessionId: string; generation: number }[] =>
    [...hosts.values()]
      .filter(
        (each) =>
          each.token === token && each !== without && each.stream !== undefined,
      )
      .map(({ id, generation }) => ({ sessionId: id, generation }));

  const poll = async (
    token: string,
    running: readonly { sessionId: string; generation: number }[],
  ): Promise<Work> =>
    json<Work>(
      request(
        "/runner/work",
        runner(token, { running, folders: [], models: [] }),
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
    const { start: assigned } = await poll(
      host.token,
      runningOn(host.token, host),
    );

    const found = assigned.find(({ sessionId }) => sessionId === host.id);

    if (found === undefined) {
      throw new Error(`no runner took Session ${host.id}`);
    }

    host.generation = found.generation;
    host.gitLogins = found.gitLogins ?? [];
    await attach(host);
  };

  const disconnect = async (host: Host): Promise<void> => {
    await poll(host.token, runningOn(host.token, host));
    host.stream?.abort();
    host.stream = undefined;
  };

  const tokens = (): Set<string> =>
    new Set([...hosts.values()].map(({ token }) => token));

  const keepUp = async (): Promise<void> => {
    for (const token of tokens()) {
      const running = runningOn(token);

      if (running.length > 0) {
        await poll(token, running);
      }
    }
  };

  const outbox = new DatabaseSync(database, { readOnly: true });

  const queuedText = outbox.prepare(
    "select text from session_outbox where session_id = ? and text is not null order by id",
  );

  const queuedCount = outbox.prepare(
    "select count(*) as count from session_outbox where session_id = ?",
  );

  const queued = (host: Host): number =>
    (queuedCount.get(host.id) as { count: number }).count;

  // Connects the host and waits until the commands the outbox held for it
  // have arrived, which can trail their rows leaving the outbox.
  const reconnect = async (host: Host): Promise<void> => {
    const expected = host.commands.length + queued(host);

    await connect(host);

    await until(() => queued(host) === 0 && host.commands.length >= expected);
  };

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

  const environments = new Map<
    string,
    { readonly token: string; readonly cookie: string }
  >();

  // An Environment with a runner of its own, which hosts the Sessions that
  // run in it.
  const environmentOf = async (owner: Owner): Promise<{ id: string }> => {
    const personal = owners.personId(owner);
    const cookie = await cookieOf(personal ?? adminId());

    const environment = await json<{ id: string; key: string }>(
      request(
        "/api/environments",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: `session-${String(environments.size + 1)}`,
            ...(personal === undefined && { team: true }),
          }),
        },
        cookie,
      ),
    );

    const joined = await json<{ token: string }>(
      request("/runner/join", runner(environment.key, { name: "runner" })),
    );

    environments.set(environment.id, { token: joined.token, cookie });

    return { id: environment.id };
  };

  const attachTo = async (sessionId: string): Promise<TestSession> => {
    const found = contextOf(plugin.id).sessions.get(sessionId);
    const environment = environments.get(found?.environmentId ?? "");

    if (found === undefined || environment === undefined) {
      throw new Error(
        `Session ${sessionId} doesn't run in one of the test's Environments`,
      );
    }

    const host: Host = hosts.get(sessionId) ?? {
      id: sessionId,
      token: environment.token,
      commands: [],
      generation: 0,
      gitLogins: [],
      stream: undefined,
    };

    hosts.set(host.id, host);

    if (host.stream === undefined) {
      await reconnect(host);
    }

    const { cookie } = environment;

    const transcriptLength = async (): Promise<number> =>
      (
        await json<{ entries: readonly string[] }>(
          request(`/runner/sessions/${host.id}/transcript`, runner(host.token)),
        )
      ).entries.length;

    const upload = async (lines: readonly unknown[]): Promise<void> => {
      await json(
        request(
          `/runner/sessions/${host.id}/transcript`,
          runner(host.token, {
            generation: host.generation,
            start: await transcriptLength(),
            lines: lines.map((line) => JSON.stringify(line)),
          }),
        ),
      );
    };

    const status = async (
      to: "running" | "idle",
      length?: number,
    ): Promise<void> => {
      const posted = await request(
        `/runner/sessions/${host.id}/events`,
        runner(host.token, {
          generation: host.generation,
          events: [
            {
              type: "status",
              status: to,
              ...(length !== undefined && { transcriptLength: length }),
            },
          ],
        }),
      );

      if (!posted.ok) {
        throw new Error(
          `the Session's events answered ${String(posted.status)}: ${await posted.text()}`,
        );
      }
    };

    return {
      id: host.id,
      environmentId: found.environmentId,
      api: pluginClient(plugin, {
        session: host.id,
        headers: { authorization: `Bearer ${host.token}` },
        fetch: async (path, init) => request(path, init),
      }),
      online: async (on) => {
        if (on && host.stream === undefined) {
          await reconnect(host);
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
      gitLogins: () => host.gitLogins,
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

        if (host.stream !== undefined) {
          await until(() =>
            host.commands.some(
              (command) => command.type === "message" && command.text === text,
            ),
          );
        }
      },
      transcript: upload,
      turn: async (lines, { uploaded = true } = {}) => {
        const end = (await transcriptLength()) + lines.length;

        await status("running");

        if (uploaded) {
          await upload(lines);
        }

        await status("idle", end);
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
  };

  let calls = 0;

  const close = async (): Promise<void> => {
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
  };

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
        kernel: async (method, path, body, headers = {}) =>
          request(
            path,
            {
              method,
              headers: {
                ...headers,
                ...(body !== undefined && {
                  "content-type": "application/json",
                }),
              },
              ...(body !== undefined && { body: JSON.stringify(body) }),
            },
            await cookieOf(personId),
          ),
      };
    },
    public: () => ({
      raw: async (method, path, init = {}) =>
        request(extPath(path), { ...init, method }),
      kernel: async (method, path, headers = {}) =>
        request(path, { method, headers }),
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
    session: async ({
      owner,
      startedBy,
      key,
      plugin: by = plugin.id,
      actsAs,
      workspace = { kind: "folder", path: root },
    }) => {
      const personal = owners.personId(owner);

      if (
        personal !== undefined &&
        startedBy !== undefined &&
        startedBy !== personal
      ) {
        throw new Error("a person's own Session is one they started");
      }

      const starter = personal ?? startedBy;
      const environment = await environmentOf(owner);

      const started = contextOf(by).sessions.start({
        environment: environment.id,
        workspace,
        actor: starter === undefined ? `plugin:${by}` : `user:${starter}`,
        ...(key !== undefined && { key }),
        ...(actsAs !== undefined && { actsAs }),
        ...(personal === undefined && {
          team: true,
          profile: await teamProfileOf(),
        }),
      });

      return attachTo(started.id);
    },
    environment: async ({ owner }) => ({ id: (await environmentOf(owner)).id }),
    attach: attachTo,
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
    editConfig: async (config) => {
      const file = JSON.parse(await readFile(configFile, "utf8")) as Readonly<
        Record<string, unknown>
      >;

      await writeFile(
        configFile,
        JSON.stringify({ ...file, [plugin.id]: config }),
      );
    },
    restart: async () => {
      await server.close();

      for (const host of hosts.values()) {
        host.stream?.abort();
      }

      contexts.clear();
      server = start();
      await ready();

      const connected = [...hosts.values()].filter(
        ({ stream }) => stream !== undefined,
      );

      for (const token of tokens()) {
        const running = runningOn(token);

        if (running.length > 0) {
          await poll(token, running);
        }
      }

      for (const host of connected) {
        await attach(host);
      }
    },
    config: async () =>
      (
        JSON.parse(
          await readFile(join(configDir, "pipoca.json"), "utf8"),
        ) as Record<string, unknown>
      )[plugin.id],
    get store() {
      return contextOf(plugin.id).store;
    },
    topics,
    log,
    close,
    [Symbol.asyncDispose]: close,
  };
}
