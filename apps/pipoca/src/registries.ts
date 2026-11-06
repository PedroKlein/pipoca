import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { format } from "prettier";
import { definedParts, type Part } from "./parts";

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

const header = "// Written by `bun run registries` from plugins/*. Don't edit.";

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
    ) as { readonly pipoca?: { readonly entry?: string } };

    const entry = packageJson.pipoca?.entry;

    if (entry === undefined) {
      throw new Error(`plugins/${id}/package.json names no pipoca.entry`);
    }

    const from = (bundle: Bundle, path: string): string => {
      const at = relative(dirname(join(root, files[bundle])), path).replace(
        /\.tsx?$/,
        "",
      );

      return JSON.stringify(at.startsWith(".") ? at : `./${at}`);
    };

    const add = (bundle: Bundle, imports: string[], line: string): void => {
      lines[bundle].imports.push(...imports);
      lines[bundle].entries.push(line);
    };

    const name = identifier(id);
    const path = join(folder, entry);
    const exported = await definitionIn(path, id);
    const named = `import { ${exported} } from ${from("server", path)};`;
    const parts = definedParts(folder);

    const imported = (bundle: Bundle, part: Part): string[] => {
      const at = parts[part];

      return at === undefined
        ? []
        : [
            `import { ${part} as ${name}${capitalized(part)} } from ${from(bundle, at)};`,
          ];
    };

    const field = (part: Part): string =>
      parts[part] === undefined ? "" : `, ${part}: ${name}${capitalized(part)}`;

    add(
      "server",
      [named, ...imported("server", "server")],
      `{ id: "${id}", definition: ${exported}${field("server")} },`,
    );

    if (parts.session !== undefined) {
      add(
        "session",
        [named, ...imported("session", "session")],
        `{ id: "${id}", definition: ${exported}${field("session")} },`,
      );
    }

    if (parts.web !== undefined) {
      add("web", imported("web", "web"), `{ id: "${id}"${field("web")} },`);
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

async function definitionIn(path: string, id: string): Promise<string> {
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

  return first[0];
}

function capitalized(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
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
