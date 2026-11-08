import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Value } from "typebox/value";
import { gitCredentials } from "@pipoca/workspaces";
import {
  listedProviders,
  type Log,
  type GitLogin,
  type ProfileFiles,
  type RegisteredProvider,
  type Timer,
} from "@pipoca/protocol";

export interface BaseListing {
  // The hash of the base Profile's files they were listed from.
  readonly hash: string;
  // False when a package didn't install or load, so a start tries again.
  readonly complete: boolean;
  readonly providers: readonly RegisteredProvider[];
}

export interface BaseListingStore {
  readonly get: () => BaseListing | undefined;
  readonly set: (listing: BaseListing) => void;
}

export interface BaseProviders {
  readonly list: () => readonly RegisteredProvider[];
  // Lists them again shortly, if the base changed since.
  readonly check: () => void;
  readonly stop: () => Promise<void>;
}

// Edits to the base come in bursts, such as a file upload after a save.
const settleMs = 2000;

// Long enough to install a few packages over a slow network.
const listingMs = 5 * 60_000;

// What the listing gets of the server's environment: what installs need, and
// no credentials, such as provider keys.
const passed = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "GIT_SSL_CAINFO",
  "PI_OFFLINE",
];

const passedPrefixes = ["LC_", "XDG_", "npm_config_", "NPM_CONFIG_"];

// The model providers the base Profile's packages and extensions register,
// so Settings can offer them before any runner has run (ADR 0044). The
// pipoca binary lists them in a process of its own, with no logins, each
// time the base changes, and the server keeps the last list.
export function baseProviders(options: {
  readonly base: () => ProfileFiles | undefined;
  readonly store: BaseListingStore;
  readonly command: readonly string[];
  readonly dir: string;
  readonly timer: Timer;
  // The git logins a package's repository installs with: those of the
  // admin who last changed the base, else the team's.
  readonly gitLogins: (repository: string) => readonly GitLogin[];
  readonly changed: () => void;
  readonly log: Log;
  readonly timeoutMs?: number;
  readonly settleMs?: number;
}): BaseProviders {
  const { store, timer, log } = options;
  let listing = store.get();
  let tried: string | undefined;
  let waiting: (() => void) | undefined;
  let listings = Promise.resolve();
  let queued = false;
  let stopped = false;
  let stopChild: (() => void) | undefined;

  const save = (next: BaseListing): void => {
    const before = JSON.stringify(listing?.providers ?? []);

    listing = next;
    store.set(next);

    if (JSON.stringify(next.providers) !== before) {
      options.changed();
    }
  };

  const listOnce = async (): Promise<void> => {
    const base = options.base() ?? { hash: "", files: {} };

    if (
      tried === base.hash ||
      (listing?.complete === true && listing.hash === base.hash)
    ) {
      return;
    }

    tried = base.hash;

    const sources = sourcesOf(base);

    const extensions = Object.keys(base.files).filter((path) =>
      path.startsWith("extensions/"),
    );

    if (sources.length === 0 && extensions.length === 0) {
      save({ hash: base.hash, complete: true, providers: [] });

      return;
    }

    const started = Date.now();

    log("listing base providers", {
      packages: sources.length,
      extensions: extensions.length,
    });

    const dir = await mkdtemp(join(options.dir, "pipoca-providers-"));

    try {
      await writeFile(join(dir, "profile.json"), JSON.stringify(base));

      const exit = await run(
        [...options.command, "list-providers", dir],
        gitCredentials(loginsFor(sources), {}),
        options.timeoutMs ?? listingMs,
      );

      if (exit !== "done") {
        log("base providers not listed", { reason: exit });

        return;
      }

      const listed: unknown = JSON.parse(
        await readFile(join(dir, "providers.json"), "utf8"),
      );

      if (!Value.Check(listedProviders, listed)) {
        log("base providers not listed", { reason: "unreadable" });

        return;
      }

      save({
        hash: base.hash,
        complete: listed.failed.length === 0,
        providers: listed.providers,
      });

      log("base providers listed", {
        providers: listed.providers.map(({ id }) => id),
        models: listed.providers.reduce(
          (n, { models }) => n + models.length,
          0,
        ),
        failed: listed.failed.map(({ source }) => source),
        ms: Date.now() - started,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  // One login per host, for the hosts of the base's git packages.
  const loginsFor = (sources: readonly string[]): readonly GitLogin[] => [
    ...new Map(
      sources
        .flatMap((source) => {
          const repository = repositoryOf(source);

          return repository === undefined ? [] : options.gitLogins(repository);
        })
        .reverse()
        .map((login) => [login.host, login]),
    ).values(),
  ];

  // The listing logs as the server does, so its lines join the server's.
  // The child keeps the git logins for its installs only.
  const run = async (
    command: readonly string[],
    credentials: Readonly<Record<string, string>>,
    timeoutMs: number,
  ): Promise<"done" | "timed out" | "failed" | "stopped"> => {
    const [program = "", ...args] = command;

    const child = spawn(program, args, {
      env: { ...listingEnv(), ...credentials, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    });

    const lines = createInterface({ input: child.stderr });

    lines.on("line", (line) => {
      relay(line, log);
    });

    let ended: "timed out" | "stopped" | undefined;

    // Installs start git and npm, which go with it.
    const kill = (why: "timed out" | "stopped"): void => {
      ended ??= why;

      try {
        process.kill(-(child.pid ?? 0), "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    stopChild = () => {
      kill("stopped");
    };

    const cancel = timer.after(timeoutMs, async () => {
      kill("timed out");

      return Promise.resolve();
    });

    const code = await new Promise<number | null>((resolve) => {
      child.on("error", (error) => {
        log("base providers not listed", { error: String(error) });
        resolve(null);
      });

      child.on("close", resolve);
    });

    cancel();
    stopChild = undefined;

    return ended ?? (code === 0 ? "done" : "failed");
  };

  // One listing at a time, and at most one more waiting behind it.
  const listAll = async (): Promise<void> => {
    if (!queued) {
      queued = true;

      listings = listings.then(async () => {
        queued = false;

        if (!stopped) {
          await listOnce().catch((error: unknown) => {
            log("base providers not listed", { error: String(error) });
          });
        }
      });
    }

    return listings;
  };

  return {
    list: () => listing?.providers ?? [],
    check: () => {
      if (stopped) {
        return;
      }

      waiting?.();

      waiting = timer.after(options.settleMs ?? settleMs, async () => {
        waiting = undefined;

        await listAll();
      });
    },
    stop: async () => {
      stopped = true;
      waiting?.();
      stopChild?.();

      await listings;
    },
  };
}

function sourcesOf(base: ProfileFiles): readonly string[] {
  const settings = base.files["settings.json"];
  if (settings === undefined) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(settings, "base64").toString("utf8"),
    );

    const packages: unknown[] =
      typeof parsed === "object" &&
      parsed !== null &&
      "packages" in parsed &&
      Array.isArray(parsed.packages)
        ? parsed.packages
        : [];

    return packages.flatMap((pkg) => {
      const source =
        typeof pkg === "object" && pkg !== null && "source" in pkg
          ? pkg.source
          : pkg;

      return typeof source === "string" ? [source] : [];
    });
  } catch {
    return [];
  }
}

// Pi reads a git package as git:host/path, an https or ssh URL, or
// git@host:path, with an optional @ref.
function repositoryOf(source: string): string | undefined {
  const found =
    /^(?:git:(?:git@)?|(?:https?|ssh):\/\/(?:[^@/]+@)?|git@)([^/:]+)[/:]([^@]+)/.exec(
      source,
    );

  return found === null
    ? undefined
    : `https://${found[1] ?? ""}/${found[2] ?? ""}`;
}

function relay(line: string, log: Log): void {
  try {
    const parsed: unknown = JSON.parse(line);

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof parsed.message === "string"
    ) {
      const {
        message,
        time: _,
        component: __,
        ...fields
      } = parsed as Readonly<Record<string, unknown>> & {
        readonly message: string;
      };

      log(message, fields);

      return;
    }
  } catch {
    // Anything else it writes, such as a package's own output.
  }

  if (line.trim() !== "") {
    log("listing base providers", { output: line });
  }
}

function listingEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        (passed.includes(entry[0]) ||
          passedPrefixes.some((prefix) => entry[0].startsWith(prefix))),
    ),
  );
}
