import { type ThinkingLevel, thinkingLevels } from "@pipoca/protocol";
import type { Folder } from "./folder";

// An agent file, agents/<name>.md, as the subagents plugin reads it.
export interface AgentFile {
  readonly path: string;
  readonly name: string;
  readonly description: string;
  readonly model: string;
  readonly thinking: ThinkingLevel | "";
  readonly tools: readonly string[];
  readonly mcp: readonly string[];
  readonly skills: readonly string[];
  readonly prompt: string;
  // Frontmatter lines the editor doesn't show, kept as they were.
  readonly rest: readonly string[];
}

// A saved workflow, workflows/<name>.js.
export interface WorkflowFile {
  readonly path: string;
  readonly name: string;
  readonly script: string;
}

// What the subagents plugin offers when no file overrides it.
export const builtinAgents = ["scout", "worker", "reviewer", "delegate"];

const agentPath = (name: string): string => `agents/${name}.md`;

export const workflowPath = (name: string): string => `workflows/${name}.js`;

const agentName = (path: string): string | undefined =>
  /^agents\/([^/]+)\.md$/.exec(path)?.[1];

const workflowName = (path: string): string | undefined =>
  /^workflows\/([^/]+)\.js$/.exec(path)?.[1];

const shown = ["name", "description", "model", "thinking"] as const;
const lists = ["tools", "mcp", "skills"] as const;

export function parseAgent(path: string, text: string): AgentFile {
  const { fields, rest, body } = frontmatter(text);

  const field = (key: string): string => {
    const value = fields.get(key);

    return typeof value === "string" ? value : (value?.join(", ") ?? "");
  };

  const list = (key: string): readonly string[] => {
    const value = fields.get(key) ?? [];

    return (typeof value === "string" ? value.split(",") : value)
      .map((item) => item.trim())
      .filter((item) => item !== "");
  };

  const thinking = field("thinking");

  return {
    path,
    name: field("name") || (agentName(path) ?? path),
    description: field("description"),
    model: field("model"),
    thinking: (thinkingLevels as readonly string[]).includes(thinking)
      ? (thinking as ThinkingLevel)
      : "",
    tools: list("tools"),
    mcp: list("mcp"),
    skills: list("skills"),
    prompt: body,
    rest,
  };
}

export function agentText(agent: AgentFile): string {
  const lines = [
    ...shown.flatMap((key) =>
      agent[key].trim() === "" ? [] : [`${key}: ${scalar(agent[key].trim())}`],
    ),
    ...lists.flatMap((key) =>
      agent[key].length === 0
        ? []
        : [`${key}: ${scalar(agent[key].join(", "))}`],
    ),
    ...agent.rest,
  ];

  return `---\n${lines.join("\n")}\n---\n\n${agent.prompt.trim()}\n`;
}

export function newAgent(name: string): AgentFile {
  return {
    path: agentPath(name),
    name,
    description: "",
    model: "",
    thinking: "",
    tools: [],
    mcp: [],
    skills: [],
    prompt: "",
    rest: [],
  };
}

// The agents a script starts, by the names its runs.run steps give.
export function startedAgents(script: string): readonly string[] {
  const names = [
    ...script.matchAll(/\bagent\s*:\s*(["'`])([\w.-]+)\1/g),
  ].flatMap(([, , name]) => (name === undefined ? [] : [name]));

  return [...new Set(names)];
}

export const workflowTemplate = `// Runs the scout, then a worker with what it found.
const found = await runs.run({ key: "scout", agent: "scout", task: args.task });

return runs.run({
  key: "work",
  agent: "worker",
  task: \`\${args.task}\\n\\nWhat the scout found:\\n\${found}\`,
});
`;

// The script's first comment line, which says what it does.
export function workflowAbout(script: string): string {
  return /^\s*\/\/\s*(.+)$/m.exec(script)?.[1]?.trim() ?? "";
}

export async function agentsIn(
  folder: Folder,
  paths: readonly string[],
): Promise<readonly AgentFile[]> {
  return Promise.all(
    paths
      .filter((path) => agentName(path) !== undefined)
      .map(async (path) => parseAgent(path, await folder.read(path))),
  );
}

export async function workflowsIn(
  folder: Folder,
  paths: readonly string[],
): Promise<readonly WorkflowFile[]> {
  return Promise.all(
    paths.flatMap((path) => {
      const name = workflowName(path);

      return name === undefined
        ? []
        : [
            folder
              .read(path)
              .then((script) => ({ path, name, script }) as const),
          ];
    }),
  );
}

// Simple YAML frontmatter: key: value lines and "- item" lists under a key.
// Anything else stays with the key above it, untouched.
function frontmatter(text: string): {
  readonly fields: ReadonlyMap<string, string | readonly string[]>;
  readonly rest: readonly string[];
  readonly body: string;
} {
  const normalized = text.replace(/\r\n?/g, "\n");

  const end = normalized.startsWith("---\n")
    ? normalized.indexOf("\n---", 3)
    : -1;

  if (end === -1) {
    return { fields: new Map(), rest: [], body: normalized.trim() };
  }

  const fields = new Map<string, string | string[]>();
  const rest: string[] = [];
  let key: string | undefined;
  const known: readonly string[] = [...shown, ...lists];

  for (const line of normalized.slice(4, end).split("\n")) {
    const pair = /^([\w-]+):\s*(.*)$/.exec(line);

    if (pair) {
      const [, name = "", value = ""] = pair;
      key = known.includes(name) ? name : undefined;

      if (key === undefined) {
        rest.push(line);
      } else {
        fields.set(key, inlineList(value) ?? unquoted(value));
      }

      continue;
    }

    const item = /^\s+-\s*(.*)$/.exec(line)?.[1];
    const current = key === undefined ? undefined : fields.get(key);

    if (key !== undefined && item !== undefined) {
      fields.set(key, [
        ...(Array.isArray(current) ? current : []),
        unquoted(item),
      ]);
    } else if (key === undefined && line.trim() !== "") {
      rest.push(line);
    }
  }

  return { fields, rest, body: normalized.slice(end + 4).trim() };
}

function inlineList(value: string): string[] | undefined {
  const inner = /^\[(.*)\]$/.exec(value.trim())?.[1];

  return inner
    ?.split(",")
    .map((item) => unquoted(item))
    .filter((item) => item !== "");
}

function unquoted(value: string): string {
  const trimmed = value.trim();

  if (/^".*"$/.test(trimmed)) {
    try {
      return String(JSON.parse(trimmed));
    } catch {
      return trimmed.slice(1, -1);
    }
  }

  return /^'.*'$/.test(trimmed)
    ? trimmed.slice(1, -1).replaceAll("''", "'")
    : trimmed;
}

// A YAML plain scalar where one reads the same, otherwise a quoted one.
function scalar(value: string): string {
  return /^[\s"'[\]{}>|*&!%@`#,?:-]|: | #|\s$|^(true|false|null|~|[\d.+-]+)$/i.test(
    value,
  ) || value.includes("\n")
    ? JSON.stringify(value)
    : value;
}
