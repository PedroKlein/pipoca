import { readFile, realpath, rm } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import * as sdk from "@pipoca/plugins";
import type { PluginDefinition } from "@pipoca/plugins";

export interface PluginParts {
  readonly server?: string;
  readonly web?: string;
  readonly session?: string;
}

// The modules a web part shares with the shell, so there is one React and one
// design system on the page (ADR 0022). The shell puts them on
// globalThis.pipocaShared.
const sharedWebModules = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@pipoca/ui",
  "@pipoca/plugins",
  "@pipoca/plugins/web",
];

// The plugin SDK a server or Session part imports is the running server's
// own, versioned with it (ADR 0046), so the errors it throws are the ones the
// server answers.
const sdkKey = "pipoca.plugins";

// Called before importing a server or Session part's bundle.
export function provideSdk(): void {
  Object.assign(globalThis, { [Symbol.for(sdkKey)]: sdk });
}

// Installs an installed plugin's dependencies and bundles its parts into
// .build in its folder, so their bare imports resolve from the plugin's own
// node_modules (ADR 0022). Returns the bundles' paths, and throws with what
// went wrong.
export async function bundleParts(
  folder: string,
  entries: PluginParts,
): Promise<PluginParts> {
  await installDependencies(folder);

  const outdir = join(folder, ".build");
  await rm(outdir, { recursive: true, force: true });

  return {
    ...(entries.server !== undefined && {
      server: await bundle(entries.server, outdir, "server", [sdkFromServer]),
    }),
    ...(entries.web !== undefined && {
      web: await bundle(entries.web, outdir, "web", [sharedWithShell]),
    }),
    ...(entries.session !== undefined && {
      session: await bundle(entries.session, outdir, "session", [
        sdkFromServer,
      ]),
    }),
  };
}

// A plugin defined with definePlugin: its definition bundled with its server
// part, and its web and Session parts each bundled without the others.
export async function bundleDefined(
  folder: string,
  entry: string,
  id: string,
): Promise<{
  readonly definition: string;
  readonly web?: string;
  readonly session?: string;
}> {
  await installDependencies(folder);

  const outdir = join(folder, ".build");
  await rm(outdir, { recursive: true, force: true });

  const isEntry = (path: string): boolean => path === entry;

  const paths = await importedDefinition(
    await bundle(entry, outdir, "parts", [
      sdkFromServer,
      partsLeftOut(isEntry),
    ]),
    id,
  );

  const at = async (
    load: PluginDefinition["server"],
  ): Promise<string | undefined> =>
    ((await load?.()) as { readonly path?: string } | undefined)?.path;

  const [server, web, session] = await Promise.all([
    at(paths.server),
    at(paths.web),
    at(paths.session),
  ]);

  return {
    definition: await bundle(entry, outdir, "server", [
      sdkFromServer,
      partsLeftOut(isEntry, server),
    ]),
    ...(web !== undefined && {
      web: await bundle(web, outdir, "web", [
        sharedWithShell,
        partsLeftOut(isEntry),
      ]),
    }),
    ...(session !== undefined && {
      session: await bundle(session, outdir, "session", [
        sdkFromServer,
        partsLeftOut(isEntry),
      ]),
    }),
  };
}

// The one definePlugin a bundle exports with the plugin's id.
export async function importedDefinition(
  path: string,
  id: string,
): Promise<PluginDefinition> {
  provideSdk();

  const found = Object.values(
    (await import(path)) as Readonly<Record<string, unknown>>,
  ).filter(
    (value): value is PluginDefinition =>
      typeof value === "object" &&
      value !== null &&
      (value as { readonly id?: unknown }).id === id,
  );

  const [definition] = found;

  if (definition === undefined || found.length > 1) {
    throw new Error(`its entry must export one definePlugin with the id ${id}`);
  }

  return definition;
}

// A definition loads each part with import(), and a part's bundle has only
// that part: the other loaders resolve to where their part is, which runs
// none of its code.
export function partsLeftOut(
  isDefinition: (path: string) => boolean,
  keep?: string,
): Bun.BunPlugin {
  return {
    name: "parts-left-out",
    setup: (build) => {
      build.onResolve({ filter: /.*/ }, ({ path, importer, kind }) => {
        if (kind !== "dynamic-import" || !isDefinition(importer)) {
          return undefined;
        }

        const resolved = Bun.resolveSync(path, dirname(importer));

        return resolved === keep
          ? undefined
          : { path: resolved, namespace: "pipoca-part" };
      });

      build.onLoad({ filter: /.*/, namespace: "pipoca-part" }, ({ path }) => ({
        contents: `export const path = ${JSON.stringify(path)};`,
        loader: "js",
      }));
    },
  };
}

// A macro runs while the bundle is built, so building a plugin that isn't
// turned on would run its code. Bun.build takes this, though its types don't
// say so.
const noMacros = { macros: false };

// Each bundle is named after its part, so its URL needs no escaping.
async function bundle(
  entry: string,
  outdir: string,
  part: "server" | "web" | "session" | "parts",
  plugins: Bun.BunPlugin[],
): Promise<string> {
  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    target: part === "web" ? "browser" : "bun",
    naming: `${part}-[hash].[ext]`,
    throw: false,
    plugins,
    ...noMacros,
    ...(part === "web" && { jsx: { development: false } }),
  });

  const [output, ...others] = result.outputs;

  if (!result.success || output === undefined) {
    throw new Error(
      `${basename(entry)} doesn't build: ${result.logs.map(described).join("\n")}`,
    );
  }

  // Only the bundle itself is served to the page or the runner, so a
  // stylesheet or file it imports would be missing there.
  if ((part === "web" || part === "session") && others.length > 0) {
    throw new Error(
      part === "web"
        ? `${basename(entry)} imports CSS or other files, which a web part can't have yet; style it with @pipoca/ui`
        : `${basename(entry)} imports files other than code, which a Session part can't have yet`,
    );
  }

  return output.path;
}

const sharedWithShell: Bun.BunPlugin = {
  name: "shared-with-shell",
  setup: (build) => {
    build.onResolve({ filter: /^[@a-z]/ }, ({ path }) =>
      sharedWebModules.includes(path)
        ? { path, namespace: "pipoca-shared" }
        : undefined,
    );

    build.onLoad({ filter: /.*/, namespace: "pipoca-shared" }, ({ path }) => ({
      contents: `module.exports = globalThis.pipocaShared[${JSON.stringify(path)}];`,
      loader: "js",
    }));
  },
};

const sdkFromServer: Bun.BunPlugin = {
  name: "sdk-from-server",
  setup: (build) => {
    build.onResolve({ filter: /^@pipoca\/plugins$/ }, ({ path }) => ({
      path,
      namespace: "pipoca-sdk",
    }));

    build.onLoad({ filter: /.*/, namespace: "pipoca-sdk" }, () => ({
      contents: `module.exports = globalThis[Symbol.for(${JSON.stringify(sdkKey)})];`,
      loader: "js",
    }));
  },
};

function described(log: BuildMessage | ResolveMessage): string {
  const { position, message } = log;

  return position === null
    ? message
    : `${position.file}:${String(position.line)}:${String(position.column)}: ${message}`;
}

const installTimeoutMs = 2 * 60_000;

// Fields that make bun install reach outside the plugin's folder, or set up
// what it does from inside it.
const outsideFields = ["workspaces", "patchedDependencies"];

const specFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "overrides",
  "resolutions",
];

const pathSpec = /^file:(.*)$|^([./~].*)$/;

const configFiles = ["bunfig.toml", ".npmrc"];

// A dependency from a path, such as one vendored in the plugin, stays inside
// its folder even through links.
async function stays(folder: string, spec: string): Promise<boolean> {
  // link: names a package registered with bun link on the machine.
  if (/^(workspace|link|portal):/.test(spec)) {
    return false;
  }

  const match = pathSpec.exec(spec);
  const path = match?.[1] ?? match?.[2];

  if (path === undefined) {
    return true;
  }

  if (path.startsWith("~") || isAbsolute(path)) {
    return false;
  }

  const real = await realpath(resolve(folder, path)).catch(() =>
    resolve(folder, path),
  );

  const within = relative(await realpath(folder), real);

  return !isAbsolute(within) && within.split(sep)[0] !== "..";
}

async function installDependencies(folder: string): Promise<void> {
  const packageJson = JSON.parse(
    await readFile(join(folder, "package.json"), "utf8"),
  ) as Record<string, unknown>;

  for (const field of outsideFields) {
    if (packageJson[field] !== undefined) {
      throw new Error(`a plugin's package.json can't have ${field}`);
    }
  }

  const specs = specFields.flatMap((field) =>
    Object.entries((packageJson[field] ?? {}) as Record<string, unknown>),
  );

  for (const [name, spec] of specs) {
    if (typeof spec !== "string" || !(await stays(folder, spec))) {
      throw new Error(
        `${name} must come from a registry, a URL or the plugin's own folder, not from elsewhere on the server`,
      );
    }
  }

  for (const file of configFiles) {
    if (await Bun.file(join(folder, file)).exists()) {
      throw new Error(
        `a plugin can't have ${file}, which would configure the server's install`,
      );
    }
  }

  const { dependencies } = packageJson as {
    dependencies?: Record<string, string>;
  };

  if (dependencies === undefined || Object.keys(dependencies).length === 0) {
    return;
  }

  // BUN_BE_BUN makes the compiled server act as the bun CLI, so installing
  // needs no npm on the machine. The server waits for this before it
  // listens, so a registry that never answers can't hold it forever, and the
  // plugin's own scripts don't run on every start.
  const install = Bun.spawn([process.execPath, "install", "--ignore-scripts"], {
    cwd: folder,
    env: { ...process.env, BUN_BE_BUN: "1" },
    stdout: "ignore",
    stderr: "pipe",
    timeout: installTimeoutMs,
  });

  const [code, errors] = await Promise.all([
    install.exited,
    new Response(install.stderr).text(),
  ]);

  if (install.signalCode !== null) {
    throw new Error(
      `installing its dependencies took longer than ${String(installTimeoutMs / 60_000)} minutes`,
    );
  }

  if (code !== 0) {
    throw new Error(`installing its dependencies failed: ${errors.trim()}`);
  }
}
