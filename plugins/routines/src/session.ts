import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
import type { Proposal } from "./model";
import type { Allowed } from "./routine";

const run = promisify(execFile);

interface Proposing {
  readonly dryRun: boolean;
  readonly actions: readonly Allowed[];
}

// A routine's run that can't push or post proposes what to write instead,
// which Pipoca applies after its turn (ADR 0076). Other Sessions get no
// tool.
export const session = defineSession(routines, async (s) => {
  const proposing = await s.api
    .get<Proposing>("run")
    .catch((error: unknown) => {
      if (error instanceof HttpError && error.status === 404) {
        return undefined;
      }

      throw error;
    });

  if (proposing === undefined || proposing.actions.length === 0) {
    return;
  }

  proposeTool(s, proposing);
});

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
