import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import {
  defineSession,
  HttpError,
  type SessionContext,
  ToolError,
  Type,
} from "@pipoca/plugins";
import { profilePath } from "@pipoca/protocol";
import { projects } from "../plugin";
import { folderSync } from "./folder-sync";
import { bytes, type FolderFile, type Membership } from "./model";

type Context = SessionContext<typeof projects>;

const skipped = new Set([".git", "node_modules", ".build"]);

// Only Sessions in a Project get the Project folder, and only the
// assistant's Sessions install what its threads built (ADR 0078, ADR 0052).
export const session = defineSession(projects, async (s) => {
  const member = await s.api
    .get<Membership>("member")
    .catch((error: unknown) => {
      if (error instanceof HttpError && error.status === 404) {
        return undefined;
      }

      throw error;
    });

  if (member === undefined) {
    return;
  }

  folderTools(s);

  if (member.assistant) {
    installTools(s);
    asksUnhinted(s);
  }
});

// Pi's own tools carry no hints. They only touch the Session's workspace,
// and tool_search only loads tools.
const workspaceTools = new Set([
  "tool_search",
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "edit",
  "write",
]);

// In the assistant a tool without hints asks before it runs, such as an MCP
// server's, and the person can let it run for the rest of the Session
// (ADR 0050).
function asksUnhinted({ extension, askPermission }: Context): void {
  extension((pi) => {
    const allowed = new Set<string>();

    pi.on("tool_call", async (event, ctx) => {
      const hints = pi
        .getAllTools()
        .find((tool) => tool.name === event.toolName)?.annotations;

      if (
        workspaceTools.has(event.toolName) ||
        allowed.has(event.toolName) ||
        hints?.readOnlyHint !== undefined ||
        hints?.destructiveHint !== undefined
      ) {
        return undefined;
      }

      const answer = await askPermission(
        `Let the assistant run “${event.toolName.replaceAll("_", " ")}”?`,
        [],
        ctx.signal,
      );

      if (answer === "session") {
        allowed.add(event.toolName);
      }

      return answer === "deny"
        ? { block: true, reason: `The person didn't allow ${event.toolName}.` }
        : undefined;
    });
  });
}

// Every Session in a Project sees the Project's folder in project/, pulled
// in the background as a turn starts and pushed after it ends (ADR 0078).
// Nothing waits on the network before a turn: Pi starts a second run if a
// prompt arrives meanwhile.
function folderTools(s: Context): void {
  const sync = folderSync(s);

  s.tools.define({
    name: "list_project_files",
    label: "List Project files",
    description:
      "Finds files in the Project's shared folder by words in their paths. Returns at most 20 matches with their full paths.",
    params: Type.Object({
      query: Type.String({
        description:
          "Words in the file's path, such as 'brief'; empty lists them all",
      }),
    }),
    annotations: { readOnly: true },
    // Its guidelines tell Pi where the folder is, so they stay in the prompt.
    exposure: "direct",
    prompt: {
      snippet: "List the files in the Project's shared folder",
      guidelines: [
        `The Project's shared folder is ${sync.dir}. Every Session in the Project and its people see it. What you change there is sent after your turn, and others' changes arrive as your turns start.`,
        'When another Session changed a file first, your version is kept beside it as "name (from <thread>).ext".',
      ],
    },
    // A file it names is here to read, even one shared since the turn began.
    run: async ({ query }) => {
      await sync.synced();

      const answer = await s.api.get<{ files: FolderFile[]; more: number }>(
        `folder/find?query=${encodeURIComponent(query)}`,
      );

      if (answer.files.length === 0) {
        return "No files match.";
      }

      const lines = answer.files.map(
        ({ path, size }) =>
          `${join(sync.dir, ...path.split("/"))} (${bytes(size)})`,
      );

      return answer.more > 0
        ? [...lines, `and ${String(answer.more)} more`].join("\n")
        : lines.join("\n");
    },
  });

  s.extension((pi) => {
    pi.on("session_start", () => {
      sync.run();
    });

    pi.on("before_agent_start", () => {
      sync.run();
    });

    pi.on("agent_settled", () => {
      sync.run();
    });

    pi.on("session_shutdown", async () => {
      await sync.flush();
    });
  });
}

// The assistant's threads build a Profile or a plugin as a folder in their
// workspace with all of Pi's tools, then install it in one call (ADR 0052).
function installTools({ api, tools }: Context): void {
  const installed = async (
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
  ): Promise<{ text: string; details: unknown }> => {
    const result = await api.post<{
      text: string;
      isError: boolean;
      opened?: unknown;
    }>("install", body, signal === undefined ? {} : { signal });

    if (result.isError) {
      throw new ToolError(result.text);
    }

    return {
      text: result.text,
      details: result.opened === undefined ? {} : { opened: result.opened },
    };
  };

  tools.define({
    name: "install_profile",
    label: "Install Profile",
    description:
      "Install a folder from the workspace as a Profile, laid out like ~/.pi/agent: AGENTS.md, settings.json, extensions/, skills/, prompts/ and themes/. Without id it makes a new Profile; with id it writes the folder's files into that Profile; with myDefaults it writes them into the user's My defaults, the layer under all their Profiles.",
    params: Type.Object({
      path: Type.String({ description: "The folder, from the workspace" }),
      name: Type.Optional(
        Type.String({ description: "The new Profile's name" }),
      ),
      id: Type.Optional(
        Type.String({ description: "The Profile to write the files into" }),
      ),
      myDefaults: Type.Optional(
        Type.Boolean({
          description:
            "Write the files into the user's My defaults instead of a Profile",
        }),
      ),
    }),
    annotations: { destructive: true },
    asks: (input) => {
      if (input.myDefaults === true) {
        return `Write the files of ${input.path} into your My defaults?`;
      }

      return input.id === undefined
        ? `Install ${input.path} as a new Profile?`
        : `Write the files of ${input.path} into the Profile ${input.id}?`;
    },
    run: async (input, { cwd, signal }) => {
      const folder = resolve(cwd, input.path);
      const paths = (await filesIn(folder)).filter(profilePath);

      return installed(
        {
          kind: "profile",
          files: await contents(folder, paths, "base64"),
          name: input.name ?? basename(folder),
          ...(input.id !== undefined && { id: input.id }),
          ...(input.myDefaults === true && { myDefaults: true }),
        },
        signal,
      );
    },
  });

  tools.define({
    name: "install_plugin",
    label: "Install plugin",
    description:
      "Install a folder from the workspace as an in-place plugin and build it. It stays off until an admin turns it on on the Plugins page. Only admins install plugins.",
    params: Type.Object({
      path: Type.String({ description: "The folder, from the workspace" }),
      plugin: Type.String({
        description: "The plugin's id, the same as in its package.json",
      }),
    }),
    annotations: { destructive: true },
    asks: (input) =>
      `Install the plugin “${input.plugin}” from ${input.path}? It stays off until an admin turns it on.`,
    run: async (input, { cwd, signal }) => {
      const folder = resolve(cwd, input.path);

      return installed(
        {
          kind: "plugin",
          plugin: input.plugin,
          files: await contents(folder, await filesIn(folder), "utf8"),
        },
        signal,
      );
    },
  });
}

async function filesIn(folder: string): Promise<string[]> {
  const entries = await readdir(folder, {
    recursive: true,
    withFileTypes: true,
  });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)))
    .filter((path) => !path.split("/").some((part) => skipped.has(part)));
}

async function contents(
  folder: string,
  paths: readonly string[],
  encoding: "base64" | "utf8",
): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      paths.map(
        async (path) =>
          [path, await readFile(join(folder, path), encoding)] as const,
      ),
    ),
  );
}
