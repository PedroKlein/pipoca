import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  defineSession,
  HttpError,
  type SessionContext,
  ToolError,
  Type,
} from "@pipoca/plugins";
import { profilePath } from "@pipoca/protocol";
import { projects } from "../plugin";
import {
  type LibraryFile,
  type Membership,
  nameRule,
  sizeRule,
  validName,
} from "./model";

type Context = SessionContext<typeof projects>;

const skipped = new Set([".git", "node_modules", ".build"]);

// Only Sessions in a Project get the library's tools, and only the
// assistant's Sessions install what its threads built (ADR 0018, ADR 0052).
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

  libraryTools(s);

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

function libraryPath(name: string): string {
  const composed = name.normalize("NFC");

  if (!validName(composed)) {
    throw new ToolError(nameRule);
  }

  return `library/${encodeURIComponent(composed)}`;
}

function libraryTools({ api, config, tools }: Context): void {
  const limit = config.fileLimitMb * 1024 * 1024;

  tools.define({
    name: "list_library",
    label: "List library",
    description:
      "List the files in the Project's shared library, with size, last writer and time.",
    params: Type.Object({}),
    annotations: { readOnly: true },
    run: async () => {
      const files = await api.get<LibraryFile[]>("library");

      return files.length === 0
        ? "The library is empty."
        : files
            .map(
              (file) =>
                `${file.name} · ${String(file.size)} bytes · ${file.actor} · ${file.updatedAt}`,
            )
            .join("\n");
    },
  });

  tools.define({
    name: "publish_file",
    label: "Publish file",
    description:
      "Copy a file from your working directory into the Project's shared library, where the user and every Project session can get it. It replaces a library file of the same name.",
    params: Type.Object({
      path: Type.String({
        description: "The file's path, relative to your working directory",
      }),
      name: Type.Optional(
        Type.String({
          description: "Its name in the library. Default: the file's name",
        }),
      ),
    }),
    annotations: { destructive: true },
    // Only replacing a file someone else may rely on asks (ADR 0050).
    asks: async (input, { cwd }) => {
      const name = (input.name ?? basename(resolve(cwd, input.path))).normalize(
        "NFC",
      );

      const files = await api.get<LibraryFile[]>("library");

      return files.some((file) => file.name === name)
        ? `Replace the library file “${name}”?`
        : undefined;
    },
    run: async (input, { cwd, signal }) => {
      const path = resolve(cwd, input.path);
      const name = input.name ?? basename(path);

      if ((await stat(path)).size > limit) {
        throw new ToolError(sizeRule(limit));
      }

      const content = await readFile(path);

      await api.put(
        libraryPath(name),
        { content: content.toString("base64") },
        signal === undefined ? {} : { signal },
      );

      return `Published ${input.path} as ${name} (${String(content.length)} bytes).`;
    },
  });

  tools.define({
    name: "fetch_file",
    label: "Fetch file",
    description:
      "Copy a file from the Project's shared library into your working directory.",
    params: Type.Object({
      name: Type.String({ description: "The library file's name" }),
      path: Type.Optional(
        Type.String({
          description:
            "Where to write it, relative to your working directory. Default: its name",
        }),
      ),
    }),
    annotations: { destructive: false },
    run: async (input, { cwd, signal }) => {
      const { content } = await api.get<{ content: string }>(
        libraryPath(input.name),
        undefined,
        signal === undefined ? {} : { signal },
      );

      const path = resolve(cwd, input.path ?? input.name);
      const bytes = Buffer.from(content, "base64");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);

      return `Wrote ${input.name} to ${path} (${String(bytes.length)} bytes).`;
    },
  });
}

// The assistant's threads build a Profile or a plugin as a folder in their
// workspace with all of Pi's tools, then install it in one call (ADR 0052).
// A new Profile is the person's own, so making one asks nothing.
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
      "Install a folder from the workspace as a Profile, laid out like ~/.pi/agent: AGENTS.md, settings.json, extensions/, skills/, prompts/ and themes/. Without id it makes a new Profile; with id it writes the folder's files into that Profile.",
    params: Type.Object({
      path: Type.String({ description: "The folder, from the workspace" }),
      name: Type.Optional(
        Type.String({ description: "The new Profile's name" }),
      ),
      id: Type.Optional(
        Type.String({ description: "The Profile to write the files into" }),
      ),
    }),
    annotations: { destructive: true },
    asks: (input) =>
      input.id === undefined
        ? undefined
        : `Write the files of ${input.path} into the Profile ${input.id}?`,
    run: async (input, { cwd, signal }) => {
      const folder = resolve(cwd, input.path);
      const paths = (await filesIn(folder)).filter(profilePath);

      return installed(
        {
          kind: "profile",
          files: await contents(folder, paths, "base64"),
          name: input.name ?? basename(folder),
          ...(input.id !== undefined && { id: input.id }),
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
