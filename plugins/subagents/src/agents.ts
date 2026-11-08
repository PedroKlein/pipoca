import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@pipoca/protocol";

export interface Agent {
  readonly name: string;
  readonly description: string;
  // Any tool the Profile gives, by name or pattern (ADR 0075).
  readonly tools: readonly string[];
  readonly mcp?: readonly string[];
  readonly skills?: readonly string[];
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  readonly prompt: string;
}

// Pi's own tools, which an agent gets when it names none.
const piTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const readOnly = ["read", "grep", "find", "ls", "bash"];

const thinkingLevels: readonly string[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const builtinAgents: readonly Agent[] = [
  {
    name: "scout",
    description:
      "Fast read-only recon of a codebase: returns the files, types and flows another agent needs to act",
    tools: readOnly,
    thinking: "low",
    prompt: `You are a scout. Find what another agent needs in order to act, and report it compactly.

- Start from the paths and symbols in the task. Prefer targeted searches and partial reads.
- Report entry points, key types and functions, data flow, the files likely to change, and open questions.
- Cite code as exact file paths and line ranges.
- Don't change files. Use bash only for read-only commands.`,
  },
  {
    name: "worker",
    description:
      "Implements a well-defined change: edits files, runs checks, reports what changed",
    tools: piTools,
    prompt: `You are a worker. Make the change the task describes, completely and no more.

- Read the relevant code before editing, and follow its conventions.
- Run the project's own checks on what you changed when there are any.
- Finish with what you changed, by file, and anything left undone.`,
  },
  {
    name: "reviewer",
    description:
      "Read-only review of a change for correctness bugs, missed requirements and risks",
    tools: readOnly,
    prompt: `You are a reviewer. Find real problems in the change the task names.

- Look for correctness bugs, missed requirements, unsafe changes and missing tests.
- For each finding give the file and line, what goes wrong, and a concrete fix.
- Skip style preferences. If you find nothing worth fixing, say so plainly.
- Don't change files.`,
  },
  {
    name: "delegate",
    description:
      "General-purpose agent with all of Pi's tools and no extra instructions",
    tools: piTools,
    prompt: "",
  },
];

export function thinkingLevel(value: unknown): ThinkingLevel | undefined {
  return typeof value === "string" && thinkingLevels.includes(value)
    ? (value as ThinkingLevel)
    : undefined;
}

function parseAgent(text: string, fallbackName: string): Agent {
  const { frontmatter, body } = parseFrontmatter(text);

  const string = (key: string): string | undefined => {
    const value = frontmatter[key];

    return typeof value === "string" && value.trim() !== ""
      ? value.trim()
      : undefined;
  };

  const list = (key: string): string[] | undefined =>
    string(key)
      ?.split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");

  const tools = list("tools");
  const mcp = list("mcp");
  const skills = list("skills");
  const thinking = thinkingLevel(string("thinking"));
  const model = string("model");

  return {
    name: string("name") ?? fallbackName,
    description: string("description") ?? "",
    tools: tools ?? piTools,
    ...(mcp !== undefined && { mcp }),
    ...(skills !== undefined && { skills }),
    ...(model !== undefined && { model }),
    ...(thinking !== undefined && { thinking }),
    prompt: body.trim(),
  };
}

// Later folders win over earlier ones, and every folder over the built-ins,
// by name. A folder that doesn't exist has no agents.
export async function loadAgents(
  folders: readonly string[],
): Promise<readonly Agent[]> {
  const byName = new Map(builtinAgents.map((agent) => [agent.name, agent]));

  for (const folder of folders) {
    const names = await readdir(folder).catch(() => []);

    for (const file of names.filter((name) => name.endsWith(".md")).sort()) {
      const agent = parseAgent(
        await readFile(join(folder, file), "utf8"),
        file.slice(0, -".md".length),
      );

      byName.set(agent.name, agent);
    }
  }

  return [...byName.values()];
}
