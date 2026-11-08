import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  defineSession,
  HttpError,
  type SessionContext,
  StringEnum,
  ToolError,
  Type,
} from "@pipoca/plugins";
import { routines } from "../plugin";
import { routineCommand } from "./command";
import { defaultMemoryFile } from "./memory";
import type { Proposal } from "./model";
import type { Allowed } from "./routine";

const run = promisify(execFile);

interface Proposing {
  readonly dryRun: boolean;
  readonly actions: readonly Allowed[];
}

interface Memory {
  readonly group: string;
  readonly files: Readonly<Record<string, string>>;
}

// A routine's run that can't push or post proposes what to write instead,
// which Pipoca applies after its turn (ADR 0076). A run of a routine in a
// group reads the group's memory as files and adds to it (ADR 0075). Other
// Sessions get no tool. Every Session gets /routine.
export const session = defineSession(routines, async (s) => {
  routineCommand(s);

  const [proposing, memory] = await Promise.all([
    unlessMissing(s.api.get<Proposing>("run")),
    unlessMissing(s.api.get<Memory>("memory")),
  ]);

  if (proposing !== undefined && proposing.actions.length > 0) {
    proposeTool(s, proposing);
  }

  if (memory !== undefined) {
    await memoryTool(s, memory);
  }
});

async function unlessMissing<T>(answer: Promise<T>): Promise<T | undefined> {
  return answer.catch((error: unknown) => {
    if (error instanceof HttpError && error.status === 404) {
      return undefined;
    }

    throw error;
  });
}

// The group's memory is kept on the server. Each turn starts with a fresh
// copy of its files in the plugin's folder, where Pi's tools read them.
async function memoryTool(
  s: SessionContext<typeof routines>,
  memory: Memory,
): Promise<void> {
  const folder = join(s.folder, "memory");

  const copy = async (files: Memory["files"]): Promise<void> => {
    await rm(folder, { recursive: true, force: true });
    await mkdir(folder, { recursive: true });

    await Promise.all(
      Object.entries(files).map(async ([file, text]) =>
        writeFile(join(folder, file), text),
      ),
    );
  };

  await copy(memory.files);

  s.extension((pi) => {
    pi.on("before_agent_start", async () => {
      await copy((await s.api.get<Memory>("memory")).files);
    });
  });

  s.tools.define({
    name: "memory",
    label: "Memory",
    description: [
      `Adds a dated note to the memory of the routine group "${memory.group}", which every run in the group reads.`,
      `Its files are in ${folder}: read them with your file tools before you start.`,
      `Notes go to ${defaultMemoryFile} unless you name another file, such as open-questions.md. Write what a later run should know, such as a decision and why.`,
    ].join(" "),
    params: Type.Object(
      {
        note: Type.String({ minLength: 1, description: "The note, Markdown" }),
        file: Type.Optional(
          Type.String({
            description: `A file name: lower-case letters, digits and dashes, ending in .md. ${defaultMemoryFile} unless given.`,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    exposure: "direct",
    annotations: { readOnly: false, destructive: false },
    run: async ({ note, file }) => {
      const files = await s.api.post<Memory["files"]>("memory", {
        note,
        ...(file !== undefined && { file }),
      });

      await copy(files);

      return `Noted in ${join(folder, file ?? defaultMemoryFile)}.`;
    },
  });
}

function proposeTool(s: SessionContext<typeof routines>, o: Proposing): void {
  const { actions } = o;

  s.tools.define({
    name: "propose",
    label: "Propose",
    description: [
      "Proposes something for Pipoca to write outside after this turn ends, since this run can't push or post itself.",
      o.dryRun
        ? "This is a dry run: proposals are shown to the person and never applied."
        : "Pipoca applies each proposal as the identity the run acts as, or waits for a person's approval when the routine asks for one.",
      "The actions the routine allows, each with the input it takes as JSON Schema:",
      ...actions.map(
        ({ name, action, max, approve }) =>
          `- ${name}: ${action.title}${action.description === undefined ? "" : `. ${action.description}`} At most ${String(max)} a run${approve ? ", each after a person approves it" : ""}. Input: ${JSON.stringify(action.input)}`,
      ),
    ].join("\n"),
    params: Type.Object(
      {
        action: StringEnum(actions.map(({ name }) => name)),
        input: Type.Record(Type.String(), Type.Unknown(), {
          description: "What the action takes, as its schema above says",
        }),
      },
      { additionalProperties: false },
    ),
    exposure: "direct",
    annotations: { readOnly: false, destructive: false },
    run: async ({ action, input }) => {
      const allowed = actions.find(({ name }) => name === action);

      const commits =
        allowed?.action.commits === true ? await bundled(s) : undefined;

      const proposal = await s.api.post<Proposal>("proposals", {
        action,
        input,
        ...(commits !== undefined && { commits }),
      });

      if (proposal.state === "refused") {
        throw new ToolError(`Refused: ${proposal.result ?? ""}`);
      }

      return `Proposed ${proposal.title}. Pipoca ${o.dryRun ? "shows it to the person, as this is a dry run" : "applies it once this turn ends"}.`;
    },
  });
}

// The commits on the workspace branch since it started, as a git bundle in
// the plugin's blob store.
async function bundled(s: SessionContext<typeof routines>): Promise<string> {
  const [checkout] = s.checkouts;

  if (checkout === undefined) {
    throw new ToolError("the workspace has no git checkout to push from");
  }

  const git = async (...args: string[]): Promise<string> =>
    (await run("git", ["-C", checkout.path, ...args])).stdout.trim();

  const branch = await git("symbolic-ref", "--short", "HEAD");
  const head = await git("rev-parse", "HEAD");

  if (checkout.base !== null && checkout.base === head) {
    throw new ToolError(
      "there are no commits on the branch to push; commit your work first",
    );
  }

  const dir = await mkdtemp(join(tmpdir(), "pipoca-bundle-"));
  const file = join(dir, "commits.bundle");

  try {
    await git(
      "bundle",
      "create",
      "--quiet",
      file,
      `refs/heads/${branch}`,
      ...(checkout.base === null ? [] : [`^${checkout.base}`]),
    );

    return (await s.blobs.upload(file)).hash;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
