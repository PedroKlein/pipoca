import { readFile, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import * as sdk from "@pipoca/plugins";
import type { PluginDefinition } from "@pipoca/plugins";
import type { ServerPart } from "@pipoca/plugins/host";

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

// Installs a plugin's dependencies and bundles its server part, or its
// definition when it has none, and its web and Session parts, each on its
// own, into .build in its folder, so their bare imports resolve from the
// plugin's own node_modules (ADR 0022). Throws with what went wrong.
export async function bundlePlugin(
  folder: string,
  entry: string,
  { server, web, session }: PluginParts,
): Promise<{
  readonly definition: string;
  readonly web?: string;
  readonly session?: string;
}> {
  await installDependencies(folder);

  const outdir = join(folder, ".build");
  await rm(outdir, { recursive: true, force: true });

  return {
    definition: await bundle(server ?? entry, outdir, "server", [
      sdkFromServer,
    ]),
    ...(web !== undefined && {
      web: await bundle(web, outdir, "web", [sharedWithShell]),
    }),
    ...(session !== undefined && {
      session: await bundle(session, outdir, "session", [sdkFromServer]),
    }),
  };
}

// The definition a bundle exports with the plugin's id, as its server part's
// or as itself.
export async function importedDefinition(
  path: string,
  id: string,
): Promise<{
  readonly definition: PluginDefinition;
  readonly server?: ServerPart;
}> {
  provideSdk();

  const module = (await import(path)) as Readonly<Record<string, unknown>>;
  const server = module["server"] as ServerPart | undefined;

  if (server !== undefined) {
    if (server.plugin.id !== id) {
      throw new Error(`its server part must be one for ${id}`);
    }

    return { definition: server.plugin, server };
  }

  const found = Object.values(module).filter(
    (value): value is PluginDefinition =>
      typeof value === "object" &&
      value !== null &&
      (value as { readonly id?: unknown }).id === id,
  );

  const [definition] = found;

  if (definition === undefined || found.length > 1) {
    throw new Error(`its entry must export one definePlugin with the id ${id}`);
  }

  return { definition };
}

// A macro runs while the bundle is built, so building a plugin that isn't
// turned on would run its code. Bun.build takes this, though its types don't
// say so.
const noMacros = { macros: false };

// Each bundle is named after its part, so its URL needs no escaping.
async function bundle(
  entry: string,
  outdir: string,
  part: "server" | "web" | "session",
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
