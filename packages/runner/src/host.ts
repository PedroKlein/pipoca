import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GitLogin, Log, SessionStart, Workspace } from "@pipoca/protocol";
import {
  hostSession,
  hostTerminals,
  restoreTranscript,
  type SessionOptions,
} from "@pipoca/sessionhost";
import {
  gitCredentials,
  hostLogins,
  prepareWorkspace,
  sessionCredentials,
  withoutGitTokens,
} from "@pipoca/workspaces";
import {
  type Agent,
  fetchGitLogins,
  fetchTranscript,
  httpSessionStream,
  reportStartFailure,
} from "./client";
import {
  binaryVolume,
  containerSession,
  pipocaImage,
  type SessionBinary,
} from "./container";
import type { ProfileFolders } from "./folders";
import type { Logins } from "./models";
import type { environmentSetup } from "./setup";
import {
  type Binary,
  pageOpener,
  sessionParts,
  spawnSession,
} from "./session-process";

// What every Session on the runner shares.
export interface Machine {
  readonly agent: Agent;
  readonly binary: Binary;
  readonly dataDir: string;
  readonly folders: readonly string[];
  readonly extensionPaths: readonly string[];
  readonly sessionBinary: string | undefined;
  readonly models: SessionOptions["models"] | undefined;
  readonly logins: Logins;
  readonly setUp: ReturnType<typeof environmentSetup>;
  readonly profiles: ProfileFolders;
  readonly docs: (
    assignment: SessionStart,
    log: Log,
  ) => Promise<string | undefined>;
}

// Within an App's installation tokens' hour, and the server keeps its own
// copies fresh for at least 45 minutes.
const loginRefreshMs = 10 * 60_000;

export interface Running {
  readonly stop: () => Promise<void>;
  // Stops the Session at once, leaving its running tools unanswered.
  readonly halt: () => Promise<void>;
}

// One attempt at running a Session, which a newer one or an unload ends.
export interface Attempt {
  readonly current: () => boolean;
  readonly fenced: () => void;
  // False when the attempt had ended already.
  readonly release: () => boolean;
}

interface Prepared {
  readonly sessionDir: string;
  // What the Session's own git and gh sign in with, and the folder of the
  // files they read.
  readonly logins: readonly GitLogin[];
  readonly gitDir: string;
  readonly image: string | undefined;
  readonly variables: Readonly<Record<string, string>>;
  readonly session: Omit<SessionOptions, "models">;
}

export function workspaceDir(dataDir: string, sessionId: string): string {
  return join(dataDir, "workspaces", sessionId);
}

// Starts an assigned Session, or reports to the server why it couldn't.
export async function startSession(
  machine: Machine,
  assignment: SessionStart,
  workspace: Workspace,
  attempt: Attempt,
  log: Log,
): Promise<Running | undefined> {
  const { sessionId, generation } = assignment;

  try {
    const prepared = await prepare(
      machine,
      assignment,
      workspace,
      attempt,
      log,
    );

    if (prepared === undefined) {
      return undefined;
    }

    const running = await launch(machine, assignment, prepared, attempt, log);

    const stopRefresh = refreshLogins(
      machine,
      assignment,
      prepared,
      attempt,
      log,
    );

    return {
      stop: async () => {
        stopRefresh();
        await running.stop();
      },
      halt: async () => {
        stopRefresh();
        await running.halt();
      },
    };
  } catch (error) {
    log("session failed to start", { error: String(error) });

    await reportStartFailure(machine.agent, sessionId, {
      generation,
      error: error instanceof Error ? error.message : String(error),
    }).catch((reportError: unknown) => {
      log("start failure not reported", { error: String(reportError) });
    });

    attempt.release();

    return undefined;
  }
}

// The Session's Profile, docs, Environment setup, workspace and transcript.
async function prepare(
  machine: Machine,
  assignment: SessionStart,
  workspace: Workspace,
  attempt: Attempt,
  log: Log,
): Promise<Prepared | undefined> {
  const { sessionId } = assignment;
  const environment = assignment.environment.variables;
  const gitLogins = hostLogins(assignment.gitLogins ?? [], environment);
  const agentDir = await machine.profiles.sync(assignment, gitLogins, log);
  const docs = await machine.docs(assignment, log);
  const sessionDir = join(machine.dataDir, "sessions", sessionId);
  const dir = workspaceDir(machine.dataDir, sessionId);
  const fresh = assignment.fresh === true;

  // Every Session of the Environment shares what its setup script makes, so
  // the script signs in only with the Environment's own token.
  const image = await machine.setUp(
    assignment.environment,
    gitCredentials(hostLogins([], environment), {
      ...process.env,
      ...environment,
    }),
  );

  if (fresh) {
    log("dropping this runner's copies of the Session", {
      reason: "it last ran on another runner",
      sessionDir,
      workspace: dir,
    });
  }

  const { cwd, checkouts } = await prepareWorkspace(
    workspace,
    {
      dir,
      folders: machine.folders,
      mirrors: join(machine.dataDir, "mirrors"),
      remoteEnv: gitCredentials(gitLogins, process.env),
      fresh,
    },
    log,
  );

  // A long clone can outlast the attempt, such as when the runner lost its
  // lease meanwhile.
  if (!attempt.current()) {
    return undefined;
  }

  const restored = await restoreTranscript(
    sessionDir,
    cwd,
    async () => fetchTranscript(machine.agent, sessionId),
    { fresh },
  );

  if (restored > 0) {
    log("transcript restored from the server", { lines: restored });
  }

  const logins = ownLogins(assignment, assignment.gitLogins ?? []);

  const own =
    assignment.proposes === true ? withoutGitTokens(environment) : environment;

  const gitDir = join(sessionDir, "git");

  const credentials = sessionCredentials(
    logins,
    { ...process.env, ...own },
    gitDir,
  );

  // Written after the restore, which may drop the Session's folder.
  await writeFiles(gitDir, credentials.files);

  // gh prefers GH_TOKEN to its config, which a refresh keeps fresh.
  const github = logins.some(({ host }) => host === "github.com");

  const variables = {
    ...Object.fromEntries(
      Object.entries(own).filter(([name]) => !github || name !== "GH_TOKEN"),
    ),
    ...(docs !== undefined && { PIPOCA_DOCS: docs }),
    ...credentials.variables,
  };

  return {
    sessionDir,
    logins,
    gitDir,
    image,
    variables,
    session: {
      cwd,
      checkouts,
      agentDir,
      ...machine.logins,
      sessionDir,
      extensionPaths: machine.extensionPaths,
      systemPrompt: assignment.systemPrompt,
      ...(docs !== undefined && { docsDir: docs }),
      trusted: assignment.trusted ?? null,
      ...(assignment.model && { model: assignment.model }),
      ...(assignment.thinking && { thinking: assignment.thinking }),
      ...(assignment.agent && { agent: assignment.agent }),
    },
  };
}

// Runs the Session's Pi in its container, in a child process, or, with
// models built in, in this one.
async function launch(
  machine: Machine,
  assignment: SessionStart,
  prepared: Prepared,
  attempt: Attempt,
  log: Log,
): Promise<Running> {
  const { sessionId, generation } = assignment;
  const { session, variables } = prepared;
  const server = machine.agent.server;
  const stream = httpSessionStream(server, assignment, log, attempt.fenced);

  const container =
    prepared.image === undefined
      ? undefined
      : await containerSession({
          sessionId,
          generation,
          image: prepared.image,
          binary: await sessionBinary(machine),
          folders: machine.folders,
          session,
          variables,
        });

  const terminals = hostTerminals(
    {
      cwd: session.cwd,
      variables,
      ...(container && { command: container.shell }),
    },
    stream,
    log,
  );

  if (machine.models && !container) {
    const hosted = await hostSession(
      {
        ...session,
        models: machine.models,
        firstMessage: assignment.firstMessage,
        ...(await sessionParts(
          machine.binary,
          server,
          assignment,
          prepared.sessionDir,
        )),
        opener: pageOpener(machine.binary),
      },
      stream,
      log,
      terminals.open,
    );

    const stop = async (): Promise<void> => {
      terminals.close();
      await hosted.stop();
    };

    return { stop, halt: stop };
  }

  const child = await spawnSession(
    machine.binary,
    {
      server,
      assignment: {
        ...assignment,
        environment: { ...assignment.environment, variables },
      },
      options: session,
    },
    log,
    terminals.open,
    container,
  );

  void child.exited.then((code) => {
    terminals.close();
    if (attempt.release()) {
      log("session process exited", { code });
    }
  });

  return {
    stop: async () => {
      terminals.close();
      await child.stop();
    },
    halt: async () => {
      terminals.close();
      await child.halt();
    },
  };
}

// A compiled agent on Linux mounts itself. One on another system copies the
// binary of its own version out of the Pipoca image, as runner pods do.
async function sessionBinary(machine: Machine): Promise<SessionBinary> {
  if (machine.sessionBinary !== undefined) {
    return { file: machine.sessionBinary };
  }

  if (!import.meta.dirname.startsWith("/$bunfs")) {
    throw new Error(
      "container Sessions need a Linux pipoca binary: start the agent with --session-binary",
    );
  }

  return process.platform === "linux"
    ? { file: process.execPath }
    : {
        volume: await binaryVolume(`${pipocaImage}:v${machine.binary.version}`),
      };
}

// The logins the Session's own git and gh get. A Session that proposes keeps
// only the logins that just read, so not the Environment's GH_TOKEN, which
// made its workspace.
function ownLogins(
  assignment: SessionStart,
  logins: readonly GitLogin[],
): readonly GitLogin[] {
  return (
    assignment.proposes === true
      ? logins
      : hostLogins(logins, assignment.environment.variables)
  ).filter(({ cloneOnly }) => cloneOnly !== true);
}

// An App's installation tokens expire within the hour, so the Session's git
// and gh get the server's current ones while it runs. A host the Session
// started without waits for its next start.
function refreshLogins(
  machine: Machine,
  assignment: SessionStart,
  prepared: Prepared,
  attempt: Attempt,
  log: Log,
): () => void {
  if (prepared.logins.length === 0) {
    return () => undefined;
  }

  const tokens = new Map(
    prepared.logins.map(({ host, token }) => [host, token]),
  );

  const refresh = async (): Promise<void> => {
    const fresh = await fetchGitLogins(machine.agent.server, assignment);

    for (const { host, token } of ownLogins(assignment, fresh)) {
      if (tokens.has(host)) {
        tokens.set(host, token);
      }
    }

    const logins = [...tokens].map(([host, token]) => ({ host, token }));

    await writeFiles(
      prepared.gitDir,
      sessionCredentials(logins, {}, prepared.gitDir).files,
    );

    log("git logins refreshed", { hosts: logins.length });
  };

  const timer = setInterval(() => {
    if (!attempt.current()) {
      clearInterval(timer);

      return;
    }

    refresh().catch((error: unknown) => {
      log("git logins not refreshed", { error: String(error) });
    });
  }, loginRefreshMs);

  return () => {
    clearInterval(timer);
  };
}

// Each file through a temporary one, so git never reads half a token.
async function writeFiles(
  dir: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    const temporary = `${path}.tmp`;

    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  }
}
