import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  Environment,
  Profile,
  ProfileContent,
  Session,
  SessionEvent,
} from "@pipoca/protocol";
import { runAgent } from "./agent";
import { runnerCredentials } from "./testdata/runners";
import { readSse } from "./sse";
import { json, testServer, type TestServer } from "./testdata/harness";
import { until } from "@pipoca/plugins/testing";

let root: string;
let server: TestServer;
let runners: ReturnType<typeof runnerCredentials>;
let faux: ReturnType<typeof fauxProvider>;
let stopAgent: () => Promise<void>;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "profile-sessions-")));
  faux = fauxProvider();

  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(faux.provider);

  server = testServer({
    runners: { pollWaitMs: 100, offlineAfterMs: 200 },
  });

  runners = runnerCredentials(server, server.signedIn);

  const controller = new AbortController();

  const done = runAgent({
    server: server.url.href,
    provider: "laptop",
    credential: { key: await runners.key("laptop") },
    dataDir: join(root, "laptop"),
    extensionPaths: [],
    folders: [root],
    models: { runtime, model: faux.getModel() },
    log: () => undefined,
    signal: controller.signal,
  });

  stopAgent = async () => {
    controller.abort();
    await done;
  };
});

afterEach(async () => {
  await stopAgent();
  await server.close();
  await rm(root, { recursive: true, force: true });
});

async function sessionWith(content: Partial<ProfileContent>): Promise<Session> {
  const profile = await json<Profile>(
    server.api("/api/profiles", {
      body: {
        name: "Work",
        ...content,
      },
    }),
  );

  let environment: Environment | undefined;
  while (environment === undefined) {
    environment = (
      await json<Environment[]>(server.api("/api/environments"))
    ).find((each) => each.online);
  }

  return json<Session>(
    server.api("/api/sessions", {
      body: {
        environment: environment.id,
        profile: profile.id,
        workspace: { kind: "folder", path: root },
      },
    }),
  );
}

async function sessionUntil(
  sessionId: string,
  done: (session: Session) => boolean,
): Promise<Session> {
  const controller = new AbortController();

  const response = await server.api(`/api/sessions/${sessionId}/events`, {
    signal: controller.signal,
  });

  for await (const event of readSse(response)) {
    const sessionEvent = event as SessionEvent;
    if (sessionEvent.type === "session" && done(sessionEvent.session)) {
      controller.abort();

      return sessionEvent.session;
    }
  }

  throw new Error("events ended");
}

async function firstRequest(session: Session): Promise<string> {
  const seen = Promise.withResolvers<string>();

  faux.setResponses([
    (context) => {
      seen.resolve(JSON.stringify(context));

      return fauxAssistantMessage([fauxText("done")]);
    },
  ]);

  await sessionUntil(session.id, ({ status }) => status === "idle");

  await json(
    server.api(`/api/sessions/${session.id}/commands`, {
      body: {
        type: "message",
        text: "hello",
      },
    }),
  );

  return seen.promise;
}

test("a Session's Pi reads the instructions its Profile holds", async () => {
  const session = await sessionWith({
    agentsMd: "Answer like a pirate.",
    appendSystemMd: "Never use tables.",
  });

  const request = await firstRequest(session);

  expect(request).toContain("Answer like a pirate.");
  expect(request).toContain("Never use tables.");
});

test("a Session gets Pipoca's and Pi's docs as files, and its Pi knows where", async () => {
  const request = await firstRequest(await sessionWith({}));
  const docs = join(root, "laptop", "docs");

  expect(request).toContain(`Its docs are in ${docs}`);

  expect(await Bun.file(join(docs, "pipoca", "plugins.md")).text()).toContain(
    "# Writing a plugin",
  );

  expect(await Bun.file(join(docs, "pi", "extensions.md")).exists()).toBe(true);
});

test("a Session loads the packages its Profile lists", async () => {
  const kit = join(root, "kit");
  await mkdir(join(kit, "extensions"), { recursive: true });

  await writeFile(
    join(kit, "package.json"),
    JSON.stringify({ name: "kit", pi: { extensions: ["./extensions"] } }),
  );

  await writeFile(
    join(kit, "extensions", "kit.ts"),
    `export default (pi) => pi.registerTool({
      name: "kit_tool",
      label: "Kit",
      description: "A tool from the Profile's package",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    });`,
  );

  const request = await firstRequest(await sessionWith({ packages: [kit] }));

  expect(request).toContain("kit_tool");
});

test("a package that can't be installed stops the Session, naming it", async () => {
  const missing = join(root, "no-such-package");
  const session = await sessionWith({ packages: [missing] });

  const failed = await sessionUntil(
    session.id,
    ({ status }) => status === "failed",
  );

  expect(failed.error).toContain(`package ${missing} failed to install`);
});

test("a machine deletes a deleted Profile's folder once its Sessions stop", async () => {
  const session = await sessionWith({ agentsMd: "Be brief." });
  await sessionUntil(session.id, ({ status }) => status === "idle");

  const dir = join(root, "laptop", "profiles", session.profileId);

  const exists = async (): Promise<boolean> =>
    stat(dir).then(
      () => true,
      () => false,
    );

  expect(await exists()).toBe(true);

  await json(server.api(`/api/sessions/${session.id}/archive`, { body: {} }));

  await server.api(`/api/profiles/${session.profileId}`, { method: "DELETE" });

  const deadline = Date.now() + 5000;
  await until(async () => !((await exists()) && Date.now() < deadline));

  expect(await exists()).toBe(false);
});

test("leaves Profile folders another server wrote in a shared data directory", async () => {
  const dataDir = join(root, "shared");
  const folder = join(dataDir, "profiles", "theirs");
  await mkdir(folder, { recursive: true });
  await writeFile(join(dataDir, "profiles", ".server"), "http://elsewhere");

  const controller = new AbortController();
  let polls = 0;

  const done = runAgent({
    server: server.url.href,
    provider: "shared",
    credential: { key: await runners.key("shared") },
    dataDir,
    extensionPaths: [],
    folders: [],
    log: (message) => {
      if (message === "provider polling for work") {
        polls++;
      }
    },
    signal: controller.signal,
  });

  await until(() => polls > 0);

  await sleep(500);
  controller.abort();
  await done;

  expect(await stat(folder).then(() => true)).toBe(true);
});

test("a git package that fails says what git said, and which host to connect", async () => {
  const source = "https://127.0.0.1:1/team/kit";
  const session = await sessionWith({ packages: [source] });

  const failed = await sessionUntil(
    session.id,
    ({ status }) => status === "failed",
  );

  expect(failed.error).toContain(`package ${source} failed to install`);
  expect(failed.error).toContain("unable to access");
  expect(failed.error).toContain("connect 127.0.0.1 in Settings");
});
