import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { StartAgent } from "@pipoca/protocol";
import { session as subagentsPart } from "@pipoca/subagents/session";
import { hostSession, type SessionStream } from "./index";

let root: string;
const agentDirBefore = process.env["PI_CODING_AGENT_DIR"];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-"));
  process.env["PI_CODING_AGENT_DIR"] = join(root, "agent");
  await mkdir(join(root, "agent", "agents"), { recursive: true });
});

afterEach(async () => {
  process.env["PI_CODING_AGENT_DIR"] = agentDirBefore;
  await rm(root, { recursive: true, force: true });
});

interface Seen {
  readonly model: string;
  readonly thinking: unknown;
  readonly system: string;
  readonly tools: readonly string[];
  readonly said: string;
}

async function agentFile(folder: string, name: string, text: string) {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${name}.md`), text);
}

// Runs a Session started as the agent until its model has answered once.
async function startedAs(
  agent: StartAgent | undefined,
  o: { readonly cwd?: string; readonly firstMessage?: string } = {},
): Promise<readonly Seen[]> {
  const faux = fauxProvider({
    models: [{ id: "main" }, { id: "deep", reasoning: true }],
  });

  const seen: Seen[] = [];

  const answer: FauxResponseFactory = async (
    context,
    options,
    _state,
    model,
  ) => {
    const system = context.messages.flatMap((m) =>
      m.role === "system" ? [m] : [],
    );

    const said = context.messages
      .flatMap((m) =>
        m.role === "user"
          ? [
              typeof m.content === "string"
                ? m.content
                : JSON.stringify(m.content),
            ]
          : [],
      )
      .join("\n");

    seen.push({
      model: model.id,
      thinking: options?.reasoning,
      system: JSON.stringify(system),
      tools: system.flatMap(({ toolsAdded = [] }) =>
        toolsAdded.map(({ name }) => name),
      ),
      said,
    });

    return Promise.resolve(fauxAssistantMessage([fauxText("ok")]));
  };

  faux.setResponses(Array.from({ length: 5 }, () => answer));

  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(faux.provider);

  const stream: SessionStream = {
    uploadTranscript: async (_start, batch) => Promise.resolve(batch.length),
    publish: async () => Promise.resolve(),
    commands: () => () => undefined,
    terminal: () => {
      throw new Error("no terminals here");
    },
    preview: () => {
      throw new Error("no previews here");
    },
    tools: async () =>
      Promise.resolve(
        ["end_run", "other_server_tool"].map((name) => ({
          name,
          description: name,
          parameters: { type: "object", properties: {} },
        })),
      ),
    callTool: async () => Promise.resolve(),
    toolQuestion: async () => Promise.resolve(undefined),
    answerTrust: async () => Promise.resolve(),
    pluginRequest: async () => Promise.resolve(Response.json({})),
  };

  const cwd = o.cwd ?? root;

  const session = await hostSession(
    {
      cwd,
      checkouts: [{ path: cwd, base: null }],
      agentDir: join(root, "agent"),
      authPath: join(root, "auth.json"),
      modelsPath: join(root, "models.json"),
      sessionDir: join(root, "sessions", crypto.randomUUID()),
      extensionPaths: [],
      trusted: false,
      models: { runtime, model: faux.getModel("main") ?? faux.getModel() },
      systemPrompt: "You are running a routine.",
      ...(agent && { agent }),
      parts: [subagentsPart],
      firstMessage: o.firstMessage ?? "go",
    },
    stream,
    () => undefined,
    () => undefined,
  );

  while (seen.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  await session.stop();

  return seen;
}

const keep = ["end_run"];

test("a Session started as an agent gets its prompt, tools and model, and keeps the tools its plugin names", async () => {
  await agentFile(
    join(root, "agent", "agents"),
    "implementer",
    "---\ndescription: Fixes bugs\ntools: read, edit\nmodel: faux/deep\nthinking: high\n---\nYou fix bugs and nothing else.",
  );

  const [seen] = await startedAs({ name: "implementer", keep });

  expect(seen?.model).toBe("deep");
  expect(seen?.thinking).toBe("high");
  expect(seen?.system).toContain("You are running a routine.");
  expect(seen?.system).toContain("You fix bugs and nothing else.");
  expect([...(seen?.tools ?? [])].sort()).toEqual(["edit", "end_run", "read"]);
});

test("without an agent of its own model, the Session's model is used, and a built-in agent is found", async () => {
  const [seen] = await startedAs({ name: "scout", keep });

  expect(seen?.model).toBe("main");
  expect(seen?.system).toContain("You are a scout.");

  expect([...(seen?.tools ?? [])].sort()).toEqual([
    "bash",
    "end_run",
    "find",
    "grep",
    "ls",
    "read",
  ]);
});

test("a Session started as no agent keeps all its tools", async () => {
  const [seen] = await startedAs(undefined);

  expect(seen?.tools).toContain("other_server_tool");
  expect(seen?.tools).toContain("write");
});

test("the Profile's agent wins over the repository's, whose own is read from its default branch", async () => {
  const origin = join(root, "origin");
  const work = join(root, "work");

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });

  await agentFile(
    join(origin, ".pi", "agents"),
    "fixer",
    "The repository's fixer.",
  );

  await agentFile(
    join(origin, ".pi", "agents"),
    "reviewer",
    "The repository's reviewer.",
  );

  git(root, "init", "-q", "-b", "main", origin);
  git(origin, "add", ".");

  git(
    origin,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    "agents",
  );

  git(root, "clone", "-q", origin, work);

  // A pull request's branch changes the agent, which must not count.
  await agentFile(
    join(work, ".pi", "agents"),
    "fixer",
    "A pull request's fixer.",
  );

  await agentFile(
    join(root, "agent", "agents"),
    "reviewer",
    "The Profile's reviewer.",
  );

  const [fixer] = await startedAs({ name: "fixer", keep }, { cwd: work });

  expect(fixer?.system).toContain("The repository's fixer.");
  expect(fixer?.system).not.toContain("A pull request's fixer.");

  const [reviewer] = await startedAs({ name: "reviewer", keep }, { cwd: work });

  expect(reviewer?.system).toContain("The Profile's reviewer.");
});

test("a Session can't start as an agent nobody has", async () => {
  const refused = await startedAs({ name: "nobody", keep }).catch(
    (error: unknown) => error,
  );

  expect(String(refused)).toContain('No agent named "nobody"');
});

test("a workflow /workflow can't start says why and gives the agent a turn", async () => {
  const [seen] = await startedAs(undefined, {
    firstMessage: '/workflow missing {"focus":"a  b"}',
  });

  expect(seen?.said).toContain("The workflow missing didn't start");
  expect(seen?.said).toContain("There are no saved workflows.");
});
