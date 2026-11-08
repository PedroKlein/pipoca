import type { Log } from "@pipoca/protocol";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import {
  DefaultPackageManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  ListedProviders,
  PiPackage,
  ProfileFiles,
} from "@pipoca/protocol";
import { type ListedModels, modelLister } from "./session";

// The package sources installed so far, so a start installs only new ones.
const installedFile = ".pipoca-packages.json";

// The hash of the files this folder holds, and their paths.
const copyFile = ".pipoca-profile.json";

// What folders written before a Profile was a whole folder held.
const earlierFiles = [
  "settings.json",
  "AGENTS.md",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
  "mcp.json",
];

// Makes a machine's folder for a Profile hold the server's Profile folder
// (ADR 0041). Pi processes of other Sessions may read the folder meanwhile,
// so packages are installed before settings.json lists them.
export async function syncProfile(
  dir: string,
  hash: string,
  download: () => Promise<ProfileFiles>,
  log: Log,
  install: InstallPackage = installPackage,
): Promise<void> {
  await syncFolder(dir, hash, download, log, {
    earlier: earlierFiles,
    prepare: async (profile) =>
      installPackages(dir, packagesOf(profile), log, install),
  });
}

// Makes a machine's folder hold the server's files, such as a Profile's or
// the docs (ADR 0052). It downloads them only when their hash differs from
// its copy's. Callers keep two syncs of one folder from overlapping. Every
// file is replaced whole, since other processes may read the folder.
export async function syncFolder(
  dir: string,
  hash: string,
  download: () => Promise<ProfileFiles>,
  log: Log,
  options: {
    // What the folder held before it kept a list of its files.
    readonly earlier?: readonly string[];
    readonly prepare?: (files: ProfileFiles) => Promise<void>;
  } = {},
): Promise<void> {
  await mkdir(dir, { recursive: true });

  const copy = await copyOf(dir);
  if (copy?.hash === hash) {
    return;
  }

  const folder = await download();

  const files = Object.entries(folder.files).map(
    ([path, content]) => [safePath(path), content] as const,
  );

  const paths = files.map(([path]) => path);

  await options.prepare?.(folder);

  for (const [path, content] of files) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await replace(join(dir, path), Buffer.from(content, "base64"));
  }

  const dropped = (copy?.files ?? options.earlier ?? []).filter(
    (path) => !paths.includes(path),
  );

  for (const path of dropped) {
    await rm(join(dir, safePath(path)), { force: true });
  }

  await replace(
    join(dir, copyFile),
    JSON.stringify({ hash: folder.hash, files: paths }),
  );

  log("folder files written", { dir, files: paths.length });
}

type InstallPackage = (dir: string, source: string) => Promise<void>;

// Installs one package into a Profile's folder, with the git credentials of
// this process's environment.
export async function installPackage(
  dir: string,
  source: string,
): Promise<void> {
  const packageManager = new DefaultPackageManager({
    cwd: dir,
    agentDir: dir,
    settingsManager: SettingsManager.create(dir, dir),
  });

  await packageManager.install(source);
}

// The model providers a Profile's packages and extensions register, listed
// with no logins in a folder of its own (ADR 0044). A package that doesn't
// install or load is left out, so the others still list.
export async function listProviders(
  dir: string,
  profile: ProfileFiles,
  log: Log,
  install: InstallPackage = installPackage,
): Promise<ListedProviders> {
  const agentDir = join(dir, "agent");
  const failed: { source: string; error: string }[] = [];
  const installed: PiPackage[] = [];

  await mkdir(agentDir, { recursive: true });

  for (const pkg of packagesOf(profile)) {
    const source = sourceOf(pkg);
    log("installing profile package", { source });

    try {
      await install(agentDir, source);
      installed.push(pkg);
    } catch (error) {
      log("profile package not installed", { source, error: String(error) });
      failed.push({ source, error: String(error) });
    }
  }

  await syncFolder(
    agentDir,
    profile.hash,
    async () => Promise.resolve(profile),
    log,
  );

  const listed = async (
    packages: readonly PiPackage[],
  ): Promise<ListedModels> => {
    await replace(
      join(agentDir, "settings.json"),
      JSON.stringify({ ...settingsOf(profile), packages }),
    );

    const list = await modelLister({
      agentDir,
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
      extensionPaths: [],
    });

    return list();
  };

  const lists: ListedModels[] = [];

  try {
    lists.push(await listed(installed));
  } catch (error) {
    // One package that fails to load stops them all, so each is listed on
    // its own.
    log("profile packages not loaded together", { error: String(error) });

    for (const pkg of installed) {
      try {
        lists.push(await listed([pkg]));
      } catch (alone) {
        const source = sourceOf(pkg);
        log("profile package not loaded", { source, error: String(alone) });
        failed.push({ source, error: String(alone) });
      }
    }
  }

  const providers = new Map(
    lists.flatMap((list) => list.providers).map((each) => [each.id, each]),
  );

  const models = lists.flatMap(({ registered }) => registered);

  return {
    providers: [...providers.values()].map((provider) => ({
      ...provider,
      models: [
        ...new Set(
          models
            .filter((model) => model.provider === provider.id)
            .map(({ id }) => id),
        ),
      ],
    })),
    failed,
  };
}

async function installPackages(
  dir: string,
  packages: readonly PiPackage[],
  log: Log,
  install: InstallPackage,
): Promise<void> {
  const installed = await installedSources(dir);

  const missing = packages
    .map(sourceOf)
    .filter((source) => !installed.has(source));

  if (missing.length === 0) {
    return;
  }

  for (const source of missing) {
    log("installing profile package", { source });

    await install(dir, source).catch((error: unknown) => {
      throw new Error(`package ${source} failed to install: ${String(error)}`, {
        cause: error,
      });
    });

    installed.add(source);
    await replace(join(dir, installedFile), JSON.stringify([...installed]));
  }

  log("profile packages installed", { count: missing.length });
}

function packagesOf(profile: ProfileFiles): readonly PiPackage[] {
  const { packages } = settingsOf(profile);

  return Array.isArray(packages) ? (packages as PiPackage[]) : [];
}

function settingsOf(profile: ProfileFiles): Readonly<Record<string, unknown>> {
  const settings = profile.files["settings.json"];
  if (settings === undefined) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(settings, "base64").toString("utf8"),
    );

    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // Pi reports a settings.json it can't read when the Session starts.
    return {};
  }
}

async function copyOf(
  dir: string,
): Promise<{ hash: string; files: readonly string[] } | undefined> {
  try {
    const copy = JSON.parse(
      await readFile(join(dir, copyFile), "utf8"),
    ) as unknown;

    return typeof copy === "object" &&
      copy !== null &&
      "hash" in copy &&
      typeof copy.hash === "string" &&
      "files" in copy &&
      Array.isArray(copy.files) &&
      copy.files.every((path) => typeof path === "string")
      ? { hash: copy.hash, files: copy.files }
      : undefined;
  } catch {
    return undefined;
  }
}

async function installedSources(dir: string): Promise<Set<string>> {
  const text = await readFile(join(dir, installedFile), "utf8").catch(
    () => "[]",
  );

  const sources: unknown = JSON.parse(text);

  return new Set(
    Array.isArray(sources)
      ? sources.filter((s): s is string => typeof s === "string")
      : [],
  );
}

// A path the server sent stays inside the folder.
function safePath(path: string): string {
  const normalized = normalize(path);
  if (
    normalized.startsWith("..") ||
    normalized.startsWith(sep) ||
    normalized.split(sep).includes("..")
  ) {
    throw new Error(`profile file ${path} is outside its folder`);
  }

  return normalized;
}

// The new file replaces the old one in one rename, so a reader never sees it
// half written.
async function replace(path: string, content: string | Buffer): Promise<void> {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

function sourceOf(pkg: PiPackage): string {
  return typeof pkg === "string" ? pkg : pkg.source;
}
