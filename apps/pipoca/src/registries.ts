import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { PluginDefinition } from "@pipoca/plugins";
import { format } from "prettier";

// The three bundles that load plugins, each from a registry this writes:
// the server, the Session host and the web app.
const files = {
  server: "apps/pipoca/src/registry-server.ts",
  session: "apps/pipoca/src/registry-session.ts",
  web: "apps/web/src/registry.ts",
} as const;

type Bundle = keyof typeof files;

interface Lines {
  readonly imports: string[];
  readonly entries: string[];
}

const header =
  "// Written by `bun run registries` from plugins/*/package.json. Don't edit.";

// Each file's content by its path from root, from what plugins/ holds now.
export async function registryFiles(
  root: string,
): Promise<ReadonlyMap<string, string>> {
  const folders = (
    await readdir(join(root, "plugins"), { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name)
    .sort();

  const lines: Record<Bundle, Lines> = {
    server: { imports: [], entries: [] },
    session: { imports: [], entries: [] },
    web: { imports: [], entries: [] },
  };

  for (const id of folders) {
    const folder = join(root, "plugins", id);

    const packageJson = JSON.parse(
      await readFile(join(folder, "package.json"), "utf8"),
    ) as {
      readonly exports?: Readonly<Record<string, string>>;
      readonly pipoca?: { readonly entry?: string };
    };

    const from = (bundle: Bundle, path: string): string => {
      const at = relative(dirname(join(root, files[bundle])), path).replace(
        /\.tsx?$/,
        "",
      );

      return JSON.stringify(at.startsWith(".") ? at : `./${at}`);
    };

    const add = (bundle: Bundle, imports: string[], entry: string): void => {
      lines[bundle].imports.push(...imports);
      lines[bundle].entries.push(entry);
    };

    const name = identifier(id);
    const entry = packageJson.pipoca?.entry;

    if (entry !== undefined) {
      const path = join(folder, entry);
      const { exported, definition } = await definitionIn(path, id);
      const named = `import { ${exported} } from ${from("server", path)};`;

      add("server", [named], `{ id: "${id}", definition: ${exported} },`);

      if (definition.session !== undefined) {
        add("session", [named], `{ id: "${id}", definition: ${exported} },`);
      }

      if (definition.web !== undefined) {
        const web = partPath(definition.web, path, id);

        add(
          "web",
          [`import * as ${name}Web from ${from("web", web)};`],
          `{ id: "${id}", part: ${name}Web },`,
        );
      }

      continue;
    }

    const exports = packageJson.exports ?? {};
    const manifest = `import ${name}Package from ${from("server", join(folder, "package.json"))};`;

    const part = (key: string): string | undefined =>
      exports[key] === undefined ? undefined : join(folder, exports[key]);

    const server = part("./server");

    add(
      "server",
      [
        manifest,
        ...(server === undefined
          ? []
          : [`import * as ${name}Server from ${from("server", server)};`]),
      ],
      `{ id: "${id}", manifest: ${name}Package.pipoca${server === undefined ? "" : `, server: ${name}Server`} },`,
    );

    const session = part("./session");

    if (session !== undefined) {
      add(
        "session",
        [
          manifest,
          `import * as ${name}Session from ${from("session", session)};`,
        ],
        `{ id: "${id}", manifest: ${name}Package.pipoca, session: ${name}Session },`,
      );
    }

    const web = part("./web");

    if (web !== undefined) {
      add(
        "web",
        [`import * as ${name}Web from ${from("web", web)};`],
        `{ id: "${id}", plugin: ${name}Web },`,
      );
    }
  }

  const rendered = await Promise.all(
    Object.entries(files).map(async ([bundle, path]) => {
      const { imports, entries } = lines[bundle as Bundle];

      const source = [
        header,
        ...new Set(imports),
        "",
        `export const ${bundle}Registry = [`,
        ...entries,
        "] as const;",
        "",
      ].join("\n");

      return [
        path,
        await format(source, { filepath: join(root, path) }),
      ] as const;
    }),
  );

  return new Map(rendered);
}

async function definitionIn(
  path: string,
  id: string,
): Promise<{
  readonly exported: string;
  readonly definition: PluginDefinition;
}> {
  const module = (await import(path)) as Readonly<Record<string, unknown>>;

  const found = Object.entries(module).filter(
    ([, value]) =>
      typeof value === "object" &&
      value !== null &&
      (value as { readonly id?: unknown }).id === id,
  );

  const [first] = found;

  if (first === undefined || found.length > 1) {
    throw new Error(`${path} must export one definePlugin with the id ${id}`);
  }

  return { exported: first[0], definition: first[1] as PluginDefinition };
}

// A part is loaded as async () => import("./path"), which the web bundle
// imports itself, since it can't follow the server's parts.
function partPath(load: () => unknown, entry: string, id: string): string {
  const match = /import\(\s*["']([^"']+)["']\s*\)/.exec(load.toString());

  if (match?.[1] === undefined) {
    throw new Error(
      `${id}'s web part must load as async () => import("./path")`,
    );
  }

  return Bun.resolveSync(match[1], dirname(entry));
}

function identifier(id: string): string {
  return id.replace(/-([a-z0-9])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "..", "..", "..");

  for (const [path, content] of await registryFiles(root)) {
    await writeFile(join(root, path), content);
  }
}
