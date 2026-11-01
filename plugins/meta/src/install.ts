import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type SessionCloud, Type } from "@pipoca/plugins";
import { profilePath, type ToolResult } from "@pipoca/protocol";

const skipped = new Set([".git", "node_modules", ".build"]);

// The assistant's threads build a Profile or a plugin as a folder in their
// workspace with all of Pi's tools, then install it in one call (ADR 0052).
export function installTools(cloud: SessionCloud): ToolDefinition[] {
  return [
    defineTool({
      name: "install_profile",
      label: "Install Profile",
      description:
        "Install a folder from the workspace as a Profile, laid out like ~/.pi/agent: AGENTS.md, settings.json, extensions/, skills/, prompts/ and themes/. Without id it makes a new Profile; with id it writes the folder's files into that Profile.",
      parameters: Type.Object({
        path: Type.String({ description: "The folder, from the workspace" }),
        name: Type.Optional(
          Type.String({ description: "The new Profile's name" }),
        ),
        id: Type.Optional(
          Type.String({ description: "The Profile to write the files into" }),
        ),
      }),
      annotations: { destructiveHint: true },
      async execute(_id, params, signal, _update, ctx) {
        const folder = resolve(ctx.cwd, params.path);
        const paths = (await filesIn(folder)).filter(profilePath);

        return installed(
          cloud,
          {
            kind: "profile",
            files: await contents(folder, paths, "base64"),
            name: params.name ?? basename(folder),
            ...(params.id !== undefined && { id: params.id }),
          },
          signal,
        );
      },
    }),
    defineTool({
      name: "install_plugin",
      label: "Install plugin",
      description:
        "Install a folder from the workspace as an in-place plugin and build it. It stays off until an admin turns it on on the Plugins page. Only admins install plugins.",
      parameters: Type.Object({
        path: Type.String({ description: "The folder, from the workspace" }),
        plugin: Type.String({
          description: "The plugin's id, the same as in its package.json",
        }),
      }),
      annotations: { destructiveHint: true },
      async execute(_id, params, signal, _update, ctx) {
        const folder = resolve(ctx.cwd, params.path);

        return installed(
          cloud,
          {
            kind: "plugin",
            plugin: params.plugin,
            files: await contents(folder, await filesIn(folder), "utf8"),
          },
          signal,
        );
      },
    }),
  ];
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

async function installed(
  cloud: SessionCloud,
  body: Readonly<Record<string, unknown>>,
  signal: AbortSignal | undefined,
): Promise<{
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
}> {
  const response = await cloud.request("install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal && { signal }),
  });

  const result = (await response.json()) as ToolResult & { message?: string };

  if (!response.ok || result.isError) {
    throw new Error(result.message ?? result.text);
  }

  return {
    content: [{ type: "text", text: result.text }],
    details: result.opened ? { opened: result.opened } : {},
  };
}
