import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  fauxAssistantMessage,
  type FauxResponseFactory,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Command, LiveEvent } from "@pipoca/protocol";
import { subagents } from "@pipoca/subagents/session";
import { hostSession, type SessionStream } from "./index";

// What the plugin publishes about its runs, as far as these tests read it.
interface RunView {
  readonly id: string;
  readonly endedAt?: number;
  readonly children: readonly {
    readonly state: string;
    readonly output?: string;
  }[];
}

let root: string;
const agentDirBefore = process.env["PI_CODING_AGENT_DIR"];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "subagents-"));
  process.env["PI_CODING_AGENT_DIR"] = join(root, "agent");
});

afterEach(async () => {
  process.env["PI_CODING_AGENT_DIR"] = agentDirBefore;
  await rm(root, { recursive: true, force: true });
});

interface Seen {
  readonly system: string;
  readonly task: string;
  readonly tools: readonly string[];
}

// One faux model for the parent and its children, as they share the
// Session's runtime. A child answers with its task's first line; the parent
// follows its script, then says "ok".
async function hosted(parent: readonly AssistantMessage[]): Promise<{
  readonly send: (text: string) => void;
  readonly lines: string[];
  readonly events: LiveEvent[];
  readonly children: Seen[];
  readonly waitFor: (predicate: () => boolean) => Promise<void>;
  readonly stop: () => Promise<void>;
}> {
  const faux = fauxProvider();
  const script = [...parent];
  const children: Seen[] = [];

  const answer: FauxResponseFactory = async (context, options) => {
    const system = context.messages.flatMap((m) =>
      m.role === "system" ? [m] : [],
    );

    const tools = system.flatMap(({ toolsAdded = [] }) =>
      toolsAdded.map(({ name }) => name),
    );

    if (!tools.includes("subagent")) {
      const first = context.messages.find((m) => m.role === "user");

      const task =
        typeof first?.content === "string"
          ? first.content
          : (first?.content ?? [])
              .flatMap((p) => (p.type === "text" ? [p.text] : []))
              .join("");

      children.push({
        system: JSON.stringify(
          system.map(({ content, sections }) => [content, sections]),
        ),
        task,
        tools,
      });

      // Runs until it is stopped.
      if (task === "hang") {
        return new Promise((resolve) => {
          options?.signal?.addEventListener("abort", () => {
            resolve(fauxAssistantMessage([], { stopReason: "aborted" }));
          });
        });
      }

      return fauxAssistantMessage([
        fauxText(`did: ${task.split("\n")[0] ?? ""}`),
      ]);
    }

    return script.shift() ?? fauxAssistantMessage([fauxText("ok")]);
  };

  faux.setResponses(Array.from({ length: 50 }, () => answer));

  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(faux.provider);

  const lines: string[] = [];
  const events: LiveEvent[] = [];
  let listener: ((command: Command) => void) | undefined;

  const stream: SessionStream = {
    uploadTranscript: async (start, batch) => {
      lines.splice(start, batch.length, ...batch);

      return Promise.resolve(lines.length);
    },
    publish: async (batch) => {
      events.push(...batch);

      return Promise.resolve();
    },
    commands: (l) => {
      listener = l;

      return () => {
        listener = undefined;
      };
    },
    terminal: () => {
      throw new Error("no terminals here");
    },
    preview: () => {
      throw new Error("no previews here");
    },
    tools: async () => Promise.resolve([]),
    callTool: async () => Promise.resolve(),
    answerTrust: async () => Promise.resolve(),
    pluginRequest: async () => Promise.resolve(Response.json({})),
  };

  const session = await hostSession(
    {
      cwd: root,
      agentDir: join(root, "agent"),
      authPath: join(root, "auth.json"),
      modelsPath: join(root, "models.json"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [],
      models: { runtime, model: faux.getModel() },
      plugins: [subagents],
    },
    stream,
    () => undefined,
    () => undefined,
  );

  return {
    send: (text) => listener?.({ actor: "user:local", type: "message", text }),
    lines,
    events,
    children,
    waitFor: async (predicate) => {
      while (!predicate()) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    stop: session.stop,
  };
}

function call(args: Parameters<typeof fauxToolCall>[1]): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall("subagent", args)], {
    stopReason: "toolUse",
  });
}

function toolResults(lines: readonly string[]): string[] {
  return lines.flatMap((line) => {
    const { message } = JSON.parse(line) as {
      message?: { role: string; content: { type: string; text?: string }[] };
    };

    return message?.role === "toolResult"
      ? message.content.flatMap((p) => p.text ?? [])
      : [];
  });
}

function latestRuns(events: readonly LiveEvent[]): readonly RunView[] {
  const published = events.findLast(
    (e) => e.type === "plugin" && e.plugin === "subagents" && e.key === "runs",
  );

  return published?.type === "plugin" ? (published.data as RunView[]) : [];
}

test("runs a subagent in the background and brings its output back to the parent", async () => {
  const session = await hosted([
    call({ agent: "scout", task: "find the parser" }),
  ]);

  session.send("look around");

  await session.waitFor(() =>
    session.lines.some((line) => line.includes('"kind":"finished"')),
  );

  await session.waitFor(
    () => latestRuns(session.events)[0]?.endedAt !== undefined,
  );

  await session.stop();

  expect(toolResults(session.lines).join()).toContain("in the background");

  const notice = session.lines.find((line) =>
    line.includes('"kind":"finished"'),
  );

  expect(notice).toContain("did: find the parser");

  const [run] = latestRuns(session.events);

  expect(run?.children).toMatchObject([
    { agent: "scout", state: "done", output: "did: find the parser" },
  ]);

  expect(session.children[0]?.tools).toEqual([
    "read",
    "grep",
    "find",
    "ls",
    "bash",
  ]);
});

test("waits for parallel runs and returns every output", async () => {
  const session = await hosted([
    call({
      tasks: [
        { agent: "reviewer", task: "review the api" },
        { agent: "reviewer", task: "review the tests" },
      ],
      wait: true,
    }),
  ]);

  session.send("review");
  await session.waitFor(() => toolResults(session.lines).length > 0);
  await session.stop();

  const [result] = toolResults(session.lines);
  expect(result).toContain("did: review the api");
  expect(result).toContain("did: review the tests");
});

test("gives each step of a chain the previous step's output", async () => {
  const session = await hosted([
    call({
      chain: [
        { agent: "scout", task: "find the bug" },
        { agent: "worker", task: "fix it" },
      ],
      wait: true,
    }),
  ]);

  session.send("fix the bug");
  await session.waitFor(() => toolResults(session.lines).length > 0);
  await session.stop();

  expect(session.children[1]?.task).toContain("fix it");
  expect(session.children[1]?.task).toContain("did: find the bug");
});

test("uses an agent from the Profile's agents folder", async () => {
  await mkdir(join(root, "agent", "agents"), { recursive: true });

  await writeFile(
    join(root, "agent", "agents", "linter.md"),
    `---
name: linter
description: Checks style
tools: read, grep
---
Only report lint problems.
`,
  );

  const session = await hosted([
    call({ agent: "linter", task: "lint src", wait: true }),
  ]);

  session.send("lint");
  await session.waitFor(() => toolResults(session.lines).length > 0);
  await session.stop();

  expect(session.children[0]?.tools).toEqual(["read", "grep"]);
  expect(session.children[0]?.system).toContain("Only report lint problems.");
});

test("names the agents there are when asked for one that doesn't exist", async () => {
  const session = await hosted([call({ agent: "nobody", task: "anything" })]);

  session.send("go");
  await session.waitFor(() => toolResults(session.lines).length > 0);
  await session.stop();

  expect(toolResults(session.lines)[0]).toContain(
    "scout, worker, reviewer, delegate",
  );
});

test("stops a run from its command, as the web's Stop button does", async () => {
  const session = await hosted([call({ agent: "delegate", task: "hang" })]);

  session.send("start something long");

  await session.waitFor(
    () => latestRuns(session.events)[0]?.children[0]?.state === "running",
  );

  const id = latestRuns(session.events)[0]?.id ?? "";
  session.send(`/subagent-stop ${id}`);

  await session.waitFor(
    () => latestRuns(session.events)[0]?.endedAt !== undefined,
  );

  await session.stop();

  expect(latestRuns(session.events)[0]?.children[0]?.state).toBe("stopped");
});
