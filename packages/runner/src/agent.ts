import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HostPort, Joined, Log } from "@pipoca/protocol";
import type { SessionOptions } from "@pipoca/sessionhost";
import { findCheckouts } from "@pipoca/workspaces";
import { httpControlPlane, joinPool, type UnsupportedVersion } from "./client";
import { docsFolder, profileFolders } from "./folders";
import { type Logins, machineModels } from "./models";
import { writeWhole } from "./parts";
import { pollForWork } from "./poll";
import { watchReach } from "./reach";
import type { Binary } from "./session-process";
import { hostedSessions } from "./sessions";
import { environmentSetup } from "./setup";

export interface AgentOptions {
  readonly server: string;
  // The runner's name in its Environment's pool (ADR 0032).
  readonly provider: string;
  // The key of the Environment it joins, or the token the server gave its
  // own runner (ADR 0033).
  readonly credential: { readonly key: string } | { readonly token: string };
  // How many Sessions it runs at once. Absent means no limit.
  readonly capacity?: number;
  // The one Session it runs, as a pod on that Session's own volume does.
  readonly session?: string;
  // Stops after running no Session for this long, as a pod started on demand
  // does (ADR 0032). Absent means it never does.
  readonly exitWhenIdleMs?: number;
  readonly dataDir: string;
  readonly extensionPaths: readonly string[];
  readonly folders: readonly string[];
  // The private hosts its owner lets the server reach through it (ADR 0080).
  readonly reach?: readonly HostPort[];
  readonly binary: Binary;
  // The Linux pipoca binary that container Sessions run. A Linux runner
  // built as a binary uses itself.
  readonly sessionBinary?: string;
  // Models built in this process can't reach a child, so with them Sessions
  // run in the agent's own process. Tests use this with Pi's faux provider.
  readonly models?: SessionOptions["models"];
  readonly log: Log;
  readonly signal: AbortSignal;
}

export async function runAgent(options: AgentOptions): Promise<void> {
  const { credential, log } = options;

  if ("token" in credential) {
    await runAs(options, credential.token).then(stopIfUnknown);

    return;
  }

  // A restart comes back with the token it joined with, which is no join, so
  // the runner isn't refused its own name while it still shows online
  // (ADR 0032). Only a token the server no longer knows makes it join again.
  const saved = await savedToken(options, credential.key);
  if (saved !== undefined) {
    if ((await runAs(options, saved)) !== "unknown_token") {
      return;
    }

    log("saved runner token refused, joining again");
  }

  const joined = await joinPool(
    options.server,
    credential.key,
    { name: options.provider },
    log,
    options.signal,
  );

  if (joined === undefined) {
    return;
  }

  await saveToken(options, credential.key, joined);
  await runAs(options, joined.token).then(stopIfUnknown);
}

function stopIfUnknown(outcome: "unknown_token" | undefined): void {
  if (outcome === "unknown_token") {
    throw new Error("the server let this runner go");
  }
}

// The runner's token, kept in its data folder for the server and the
// Environment key it joined with, so another --server or key joins anew.
interface SavedRunner {
  readonly server: string;
  readonly environment: string;
  readonly runner: string;
  readonly key: string;
  readonly token: string;
}

const savedRunnerFile = "runner.json";

async function savedToken(
  options: AgentOptions,
  key: string,
): Promise<string | undefined> {
  const path = join(options.dataDir, savedRunnerFile);

  try {
    const saved = JSON.parse(
      await readFile(path, "utf8"),
    ) as Partial<SavedRunner>;

    return saved.server === options.server &&
      saved.runner === options.provider &&
      saved.key === keyHash(key) &&
      typeof saved.token === "string"
      ? saved.token
      : undefined;
  } catch {
    return undefined;
  }
}

async function saveToken(
  options: AgentOptions,
  key: string,
  joined: Joined,
): Promise<void> {
  const saved: SavedRunner = {
    server: options.server,
    environment: joined.environment,
    runner: options.provider,
    key: keyHash(key),
    token: joined.token,
  };

  await writeWhole(
    join(options.dataDir, savedRunnerFile),
    JSON.stringify(saved),
    0o600,
  );
}

function keyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// A token the server refused before any poll got through is "unknown_token",
// so a saved one can be replaced by joining again.
async function runAs(
  options: AgentOptions,
  token: string,
): Promise<"unknown_token" | undefined> {
  const { log, dataDir } = options;
  const agent = { server: options.server, token };
  const logins = await machineLogins(dataDir, log);

  const models = machineModels({
    logins,
    extensionPaths: options.extensionPaths,
    ...(options.models && { models: options.models }),
    log,
  });

  const profiles = await profileFolders({
    dataDir,
    server: options.server,
    binary: options.binary,
    models,
    log,
  });

  for (const dir of [join(dataDir, "models"), ...(await profiles.dirs())]) {
    models.add(dir);
  }

  await models.relist();
  const stopRelisting = models.follow(options.signal);

  // The roots and the checkouts found under them, for the UI to suggest.
  const checkouts = await findCheckouts(options.folders);
  log("checkouts found", { count: checkouts.length });

  const sessions = hostedSessions(
    {
      agent,
      binary: options.binary,
      dataDir,
      folders: options.folders,
      extensionPaths: options.extensionPaths,
      sessionBinary: options.sessionBinary,
      models: options.models,
      logins,
      setUp: environmentSetup(join(dataDir, "setup"), log, options.signal),
      profiles,
      docs: docsFolder(dataDir, options.server),
    },
    log,
  );

  // A server that no longer knows the token, as after a new key, has let the
  // runner go, and so has one of another protocol version. It stops instead
  // of polling forever.
  const letGo = new AbortController();
  let unsupported: UnsupportedVersion | undefined;
  const progress = { polled: false };
  const idle = idleExit(options.exitWhenIdleMs, sessions.count, log);

  const controlPlane = httpControlPlane(agent, (reason) => {
    unsupported = reason;

    log(
      reason?.message ??
        "the server let this runner go; join again with the Environment's key",
    );

    letGo.abort();
  });

  const reach = watchReach(options.reach ?? [], log, options.signal);

  await pollForWork({
    controlPlane: {
      work: async (poll, signal) => {
        const work = await controlPlane.work(poll, signal);
        progress.polled = true;

        return work;
      },
    },
    log,
    signal: AbortSignal.any([options.signal, letGo.signal, idle.signal]),
    folders: [...new Set([...options.folders, ...checkouts])],
    ...(options.capacity !== undefined && { capacity: options.capacity }),
    ...(options.session !== undefined && { session: options.session }),
    models: models.models,
    registeredModels: models.registered,
    ...(options.reach !== undefined && options.reach.length > 0 && { reach }),
    running: sessions.running,
    start: sessions.start,
    unload: sessions.unload,
    remove: sessions.remove,
    profiles: (ids) => {
      profiles.keep(ids, sessions.usesProfile);
    },
  }).finally(() => {
    idle.stop();
    stopRelisting();
  });

  await sessions.stopAll(options.signal.aborted);

  if (unsupported !== undefined) {
    throw unsupported;
  }

  if (letGo.signal.aborted) {
    if (progress.polled) {
      throw new Error("the server let this runner go");
    }

    return "unknown_token";
  }

  return undefined;
}

// The machine's logins, which every Profile uses (ADR 0031). They have a
// folder of their own, which container Sessions mount to take Pi's lock files
// next to them.
async function machineLogins(dataDir: string, log: Log): Promise<Logins> {
  const dir = join(dataDir, "logins");
  await mkdir(dir, { recursive: true });

  const logins = {
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
  };

  if (
    existsSync(join(homedir(), ".pi", "agent", "auth.json")) &&
    !existsSync(logins.authPath)
  ) {
    log("this machine's model logins now live in the data directory", {
      authPath: logins.authPath,
      hint: "log in again with /login from any session",
    });
  }

  return logins;
}

function idleExit(
  afterMs: number | undefined,
  hosting: () => number,
  log: Log,
): { readonly signal: AbortSignal; readonly stop: () => void } {
  const controller = new AbortController();
  if (afterMs === undefined) {
    return { signal: controller.signal, stop: () => undefined };
  }

  let idleSince = Date.now();

  const timer = setInterval(
    () => {
      if (hosting() > 0) {
        idleSince = Date.now();

        return;
      }

      if (Date.now() - idleSince >= afterMs) {
        log("no sessions for a while; stopping", { idleMs: afterMs });
        controller.abort();
      }
    },
    Math.min(afterMs, 1000),
  );

  return {
    signal: controller.signal,
    stop: () => {
      clearInterval(timer);
    },
  };
}
