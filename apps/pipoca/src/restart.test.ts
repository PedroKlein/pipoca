import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  Environment,
  Prompt,
  Session,
  SessionEvent,
} from "@pipoca/protocol";
import { runAgent } from "./agent";
import { supervised } from "./restart";
import type { ServeOptions } from "./serve";
import { readSse } from "./sse";
import { runnerCredentials } from "./testdata/runners";
import { closeServers, testServer, type TestServer } from "./testdata/harness";
import { until } from "@pipoca/plugins/testing";

let root: string | undefined;
let server: TestServer;

afterEach(async () => {
  await closeServers();

  if (root !== undefined) {
    await rm(root, { recursive: true, force: true });
  }
});

async function start(options: Partial<ServeOptions> = {}): Promise<void> {
  server = testServer({
    sessions: { pollWaitMs: 100 },
    ...options,
  });

  await server.signedIn();
}

test("restarts when something starts the server again", async () => {
  let restarted = false;

  await start({
    restart: () => {
      restarted = true;
    },
  });

  expect((await server.api("/api/restart", { body: {} })).status).toBe(202);

  await Bun.sleep(200);
  expect(restarted).toBe(true);
});

test("says to restart by hand when nothing would start the server again", async () => {
  await start();

  const refused = await server.api("/api/restart", { body: {} });

  expect(refused.status).toBe(400);
  expect(await refused.text()).toContain("restart it yourself");
});

test("asks first while a Session on the server's own runner is mid-turn", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pipoca-restart-")));
  const faux = fauxProvider();

  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(faux.provider);

  let finish = (): void => undefined;

  const answered = new Promise<void>((resolve) => {
    finish = resolve;
  });

  faux.setResponses([
    async () => {
      await answered;

      return fauxAssistantMessage([fauxText("done")]);
    },
  ]);

  let restarted = 0;

  await start({
    agent: {
      provider: "local",
      dataDir: join(root, "local"),
      extensionPaths: [],
      folders: [root],
      models: { runtime, model: faux.getModel() },
    },
    restart: () => {
      restarted += 1;
    },
  });

  await until(
    async () =>
      ((await (await server.api("/api/environments")).json()) as unknown[])
        .length > 0,
  );

  const session = (await (
    await server.api("/api/sessions", {
      body: {
        workspace: { kind: "folder", path: root },
        firstMessage: "Take your time",
      },
    })
  ).json()) as Session;

  await until(
    async () =>
      (
        (await (
          await server.api(`/api/sessions/${session.id}`)
        ).json()) as Session
      ).status === "running",
  );

  const asked = await server.api("/api/restart", { body: {} });

  expect(asked.status).toBe(409);

  expect(await asked.json()).toEqual({
    error: "busy",
    message: "Sessions are mid-turn on the server's own runner.",
    sessions: 1,
  });

  expect(
    (await server.api("/api/restart", { body: { force: true } })).status,
  ).toBe(202);

  await Bun.sleep(200);
  expect(restarted).toBe(1);
  finish();
});

test("counts a Session its own runner is starting, and none of another runner's", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pipoca-restart-")));
  const own = join(root, "own");
  const other = join(root, "other");
  const ready = join(root, "ready");
  await Promise.all([mkdir(own), mkdir(other)]);

  const faux = fauxProvider();

  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(faux.provider);

  let finish = (): void => undefined;

  const answered = new Promise<void>((resolve) => {
    finish = resolve;
  });

  faux.setResponses([
    async () => {
      await answered;

      return fauxAssistantMessage([fauxText("done")]);
    },
  ]);

  const models = { runtime, model: faux.getModel() };

  await start({
    agent: {
      provider: "local",
      dataDir: join(root, "local"),
      extensionPaths: [],
      folders: [own],
      models,
    },
    restart: () => undefined,
  });

  let environment: Environment | undefined;
  while (environment === undefined) {
    [environment] = (await (
      await server.api("/api/environments")
    ).json()) as Environment[];

    await Bun.sleep(10);
  }

  await server.api(`/api/environments/${environment.id}`, {
    method: "PATCH",
    body: {
      setupScript: `while [ ! -f "${ready}" ]; do sleep 0.05; done`,
    },
  });

  const { key } = (await (
    await server.api(`/api/environments/${environment.id}/key`, { body: {} })
  ).json()) as { key: string };

  const stopOther = new AbortController();

  const otherRunner = runAgent({
    server: server.url.href,
    provider: "other",
    credential: { key },
    dataDir: join(root, "other-data"),
    extensionPaths: [],
    folders: [other],
    models,
    log: () => undefined,
    signal: stopOther.signal,
  });

  const created = async (path: string, firstMessage?: string) =>
    (await (
      await server.api("/api/sessions", {
        body: {
          workspace: { kind: "folder", path },
          ...(firstMessage !== undefined && { firstMessage }),
        },
      })
    ).json()) as Session;

  const reaches = async (id: string, status: Session["status"]) => {
    await until(
      async () =>
        ((await (await server.api(`/api/sessions/${id}`)).json()) as Session)
          .status === status,
    );
  };

  const starting = await created(own);
  await reaches(starting.id, "starting");

  const whileStarting = await server.api("/api/restart", { body: {} });

  await writeFile(ready, "");
  await reaches(starting.id, "idle");

  const elsewhere = await created(other, "Take your time");
  await reaches(elsewhere.id, "running");

  const whileOtherRuns = await server.api("/api/restart", { body: {} });

  expect([whileStarting.status, whileOtherRuns.status]).toEqual([409, 202]);

  finish();
  stopOther.abort();
  await otherRunner;
}, 30_000);

test("shows a waiting Session's open prompt again after the server restarts", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pipoca-restart-")));
  const database = join(root, "server.db");
  const extension = join(root, "ask.ts");

  await writeFile(
    extension,
    `export default (pi) => pi.registerTool({
      name: "ask",
      label: "Ask",
      description: "Asks the user",
      parameters: { type: "object", properties: {} },
      execute: async (_id, _params, _signal, _update, ctx) => {
        const picked = await ctx.ui.select("Which one?", ["red", "blue"]);
        return { content: [{ type: "text", text: "picked " + picked }], details: {} };
      },
    });`,
  );

  const faux = fauxProvider();

  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(faux.provider);

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("ask", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("done")]),
  ]);

  await start({ database });
  const port = Number(server.url.port);

  const runners = runnerCredentials(server, server.signedIn);

  const stopAgent = new AbortController();

  const agent = runAgent({
    server: server.url.href,
    provider: "laptop",
    credential: { key: await runners.key("laptop") },
    dataDir: join(root, "laptop"),
    extensionPaths: [extension],
    folders: [root],
    models: { runtime, model: faux.getModel() },
    log: () => undefined,
    signal: stopAgent.signal,
  });

  try {
    const session = (await (
      await server.api("/api/sessions", {
        body: {
          workspace: { kind: "folder", path: root },
          firstMessage: "Pick a colour",
        },
      })
    ).json()) as Session;

    const firstPrompt = async (): Promise<Prompt | undefined> => {
      const response = await server.api(`/api/sessions/${session.id}/events`);
      for await (const data of readSse(response)) {
        const event = data as SessionEvent;
        if (event.type === "live" && event.event.type === "prompt") {
          return event.event.prompt;
        }
      }

      return undefined;
    };

    await firstPrompt();
    const cookie = await server.signedIn();
    await server.close();

    server = testServer({
      port,
      database,
      sessions: { pollWaitMs: 100 },
      cookie,
    });

    const asked = await Promise.race([
      firstPrompt(),
      Bun.sleep(5_000).then(() => undefined),
    ]);

    let restarted = (await (
      await server.api(`/api/sessions/${session.id}`)
    ).json()) as Session;

    while (!restarted.online) {
      await Bun.sleep(20);

      restarted = (await (
        await server.api(`/api/sessions/${session.id}`)
      ).json()) as Session;
    }

    expect(asked?.title).toBe("Which one?");
    expect(restarted).toMatchObject({ status: "running", waiting: true });

    const answered = await server.api(`/api/sessions/${session.id}/commands`, {
      body: {
        type: "answer",
        id: asked?.id,
        value: "blue",
      },
    });

    expect(answered.status).toBe(202);

    const response = await server.api(`/api/sessions/${session.id}/events`);
    for await (const data of readSse(response)) {
      const event = data as SessionEvent;
      if (event.type === "entry" && event.entry.includes("picked blue")) {
        break;
      }
    }
  } finally {
    stopAgent.abort();
    await agent;
  }
}, 30_000);

test("leaves no supervisor mark for a server started inside a Session", () => {
  const env: NodeJS.ProcessEnv = { INVOCATION_ID: "abc", PATH: "/bin" };

  expect(supervised(env)).toBe(true);
  expect(env).toEqual({ PATH: "/bin" });
  expect(supervised(env)).toBe(false);
});
