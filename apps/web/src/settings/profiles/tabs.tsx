import { Tabs } from "@pipoca/ui";
import type { ReactElement } from "react";
import type { Folder } from "./folder";
import { type Kind, KindFiles } from "./files";
import { NamedFiles, type OneFile } from "./named-files";

// The base Profile's packages and AGENTS.md, which every Session loads under
// its own Profile's (ADR 0044).
const tabs: readonly (readonly [string, string])[] = [
  ["overview", "Overview"],
  ["instructions", "Instructions"],
  ["skills", "Skills"],
  ["prompts", "Prompts"],
  ["extensions", "Extensions"],
  ["mcp", "MCP"],
  ["models", "Models"],
  ["settings", "Settings"],
  ["files", "Files"],
];

const kinds: Readonly<Record<string, Kind>> = {
  skills: {
    title: "Skills",
    about:
      "A skill is a folder with a SKILL.md. Pi lists each skill's name and description to the model, which reads the rest when a task needs it. /skill:name runs one.",
    nameOf: (path) => /^skills\/(?:.+\/)?([^/]+)\/SKILL\.md$/.exec(path)?.[1],
    newPath: (name) => `skills/${name}/SKILL.md`,
    template: (name) =>
      `---\nname: ${name}\ndescription: What it does, and when to use it.\n---\n\n# ${name}\n`,
    placeholder: "review",
    folder: "skills/",
  },
  prompts: {
    title: "Prompts",
    about:
      "A prompt template becomes a slash command named after its file, so prompts/review.md is /review. $1, $@ and ${1:-default} take its arguments.",
    nameOf: (path) => /^prompts\/([^/]+)\.md$/.exec(path)?.[1],
    newPath: (name) => `prompts/${name}.md`,
    template: () =>
      '---\ndescription: What the command does\nargument-hint: "[focus]"\n---\nDo the task. Focus on ${1:-correctness}.\n',
    placeholder: "review",
    folder: "prompts/",
  },
  extensions: {
    title: "Extensions",
    about:
      "An extension is a TypeScript file, or a folder with an index.ts, that adds tools, commands or model providers. One that needs npm dependencies goes in Overview as a Pi package instead.",
    nameOf: (path) =>
      /^extensions\/([^/]+?)(?:\.[jt]s|\/index\.[jt]s)$/.exec(path)?.[1],
    newPath: (name) => `extensions/${name}.ts`,
    template: (name) =>
      `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\n\nexport default function (pi: ExtensionAPI) {\n  pi.registerCommand("${name}", {\n    description: "Say hello",\n    handler: async (_args, ctx) => {\n      ctx.ui.notify("Hello!", "info");\n    },\n  });\n}\n`,
    placeholder: "hello",
    folder: "extensions/",
  },
  files: {
    title: "Files",
    about:
      "Every file in the folder, as Pi reads them from ~/.pi/agent, such as themes/ and keybindings.json for Pi in a terminal. Uploading a folder such as ~/.pi/agent leaves out logins and history.",
    nameOf: (path) => path,
    newPath: (path) => path,
    template: () => "",
    placeholder: "skills/review/SKILL.md",
  },
};

const namedFiles: Readonly<
  Record<string, { readonly title: string; readonly files: readonly OneFile[] }>
> = {
  instructions: {
    title: "Instructions",
    files: [
      {
        path: "AGENTS.md",
        about:
          "Instructions for every Session, next to the AGENTS.md files of the repository it works in.",
        example: "Answer briefly. Run the tests before saying something works.",
      },
      {
        path: "APPEND_SYSTEM.md",
        about: "Added to the end of Pi's system prompt.",
        example: "Always reply in English.",
      },
      {
        path: "SYSTEM.md",
        about:
          "Replaces Pi's whole system prompt. Leave it empty unless you mean that.",
        example: "You are a careful coding assistant…",
      },
    ],
  },
  mcp: {
    title: "MCP servers",
    files: [
      {
        path: "mcp.json",
        about:
          "MCP servers every Session can use. ${NAME} in a value reads an Environment secret.",
        example: `{\n  "mcpServers": {\n    "docs": {\n      "url": "https://example.com/mcp",\n      "headers": { "Authorization": "Bearer \${DOCS_TOKEN}" }\n    }\n  }\n}`,
      },
    ],
  },
  models: {
    title: "Models",
    files: [
      {
        path: "models.json",
        about:
          "Endpoints that speak an API Pi knows, such as Ollama or a proxy, and overrides for existing models. Keys can name an Environment secret as $NAME.",
        example: `{\n  "providers": {\n    "ollama": {\n      "baseUrl": "http://localhost:11434/v1",\n      "api": "openai-completions",\n      "apiKey": "ollama",\n      "models": [{ "id": "qwen2.5-coder:7b" }]\n    }\n  }\n}`,
      },
    ],
  },
  settings: {
    title: "Settings",
    files: [
      {
        path: "settings.json",
        about:
          "Pi's settings, such as defaultProvider, defaultModel and defaultThinkingLevel. Its packages are the ones in Overview.",
        example: `{\n  "defaultThinkingLevel": "medium"\n}`,
      },
    ],
  },
};

export function ProfileTabs({
  folder,
  base,
  tab,
  overview,
}: {
  readonly folder: Folder;
  // The link to the open Profile or layer, such as #settings/profiles/p1.
  readonly base: string;
  readonly tab: string;
  readonly overview: ReactElement;
}): ReactElement {
  const kind = kinds[tab];
  const named = namedFiles[tab];

  const overviewShown = tab === "overview" || (!kind && !named);

  return (
    <>
      {overviewShown ? (
        <a
          href={`${base}/files`}
          className="mt-3 self-start rounded-md px-2 py-1 text-label text-fg-dim hover:bg-hover hover:text-fg"
        >
          Open as files
        </a>
      ) : (
        <Tabs
          label="Profile"
          className="mt-6"
          value={tab}
          tabs={tabs.map(([key, label]) => ({
            value: key,
            label,
            href: `${base}/${key}`,
          }))}
        />
      )}
      {overviewShown && overview}
      {kind && (
        <KindFiles key={`${folder.key}:${tab}`} folder={folder} kind={kind} />
      )}
      {named && (
        <NamedFiles
          key={`${folder.key}:${tab}`}
          folder={folder}
          title={named.title}
          files={named.files}
        />
      )}
    </>
  );
}
