import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentOptions } from "@pipoca/plugins";
import { loadAgents } from "./agents";

const run = promisify(execFile);

const defaultBranch = "origin/HEAD";

// The agent a Session starts as (ADR 0075). The Profile's wins, then a
// repository's on its default branch, then a built-in, so an issue or a pull
// request can't swap the agent a routine runs.
export async function namedAgent(
  name: string,
  profileAgents: string,
  repositories: readonly string[],
): Promise<AgentOptions> {
  const folder = await mkdtemp(join(tmpdir(), "pipoca-agents-"));

  try {
    const copied = await Promise.all(
      repositories.map(async (repository, index) =>
        defaultBranchAgents(repository, join(folder, String(index))),
      ),
    );

    const agents = await loadAgents([
      ...copied.flatMap((each) => (each === undefined ? [] : [each])).reverse(),
      profileAgents,
    ]);

    const agent = agents.find((each) => each.name === name);

    if (agent === undefined) {
      throw new Error(
        `No agent named "${name}" in the Profile, the repository or the built-in agents. The agents are: ${agents.map((each) => each.name).join(", ")}.`,
      );
    }

    return {
      tools: agent.tools,
      ...(agent.model !== undefined && { model: agent.model }),
      ...(agent.thinking !== undefined && { thinking: agent.thinking }),
      ...(agent.prompt !== "" && { systemPrompt: agent.prompt }),
    };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

// The repository's .pi/agents on its default branch, copied into the folder,
// or undefined when it has none.
async function defaultBranchAgents(
  repository: string,
  folder: string,
): Promise<string | undefined> {
  const git = async (...args: string[]): Promise<string> =>
    (await run("git", ["-C", repository, ...args])).stdout;

  const listed = await git(
    "ls-tree",
    "--name-only",
    `${defaultBranch}:.pi/agents`,
  ).catch(() => undefined);

  const files = (listed ?? "")
    .split("\n")
    .filter((file) => file.endsWith(".md"));

  if (files.length === 0) {
    return undefined;
  }

  await mkdir(folder, { recursive: true });

  for (const file of files) {
    await writeFile(
      join(folder, file),
      await git("show", `${defaultBranch}:.pi/agents/${file}`),
    );
  }

  return folder;
}
