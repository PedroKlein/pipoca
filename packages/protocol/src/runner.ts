import { Type } from "typebox";
import { postedEvent } from "./events";
import { pluginSettings } from "./plugins";
import { isolation, modelRef, thinkingLevel, workspace } from "./session";
import type { Workspace } from "./session";
import { integer, nullable, strings, textMap, type Wire } from "./wire";

export const protocolVersion = 4;
export const versionHeader = "pipoca-protocol";

// Runner and Environment names show in logs, container names and paths.
export const runnerName = Type.String({
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
});

// A runner joins the pool of the Environment whose key it holds, under a name
// of its own, and gets a token for its other calls (ADR 0033).
export const joinRequest = Type.Object({ name: runnerName });

export type JoinRequest = Wire<typeof joinRequest>;

export const joined = Type.Object({
  token: Type.String(),
  // The provider name of the Environment it joined.
  environment: Type.String(),
});

export type Joined = Wire<typeof joined>;

// A runner's lease on its Sessions lasts this long after its last poll. Then
// a Session whose Workspace can be made again elsewhere moves to another
// runner, so a runner that can't poll stops those Sessions well before
// (ADR 0032).
export const leaseMs = 60_000;

// A Profile folder's or the docs folder's files by their path in it, base64
// encoded, and a hash of them all, which runners compare with their copy's
// (ADR 0041, ADR 0052).
export const profileFiles = Type.Object({
  hash: Type.String(),
  files: textMap,
});

export type ProfileFiles = Wire<typeof profileFiles>;

const gitLogin = Type.Object({ host: Type.String(), token: Type.String() });

export type GitLogin = Wire<typeof gitLogin>;

// What a Session's Environment sets up on its machine (ADR 0032). The
// variables hold the Environment's secrets too.
const sessionEnvironment = Type.Object({
  isolation,
  image: nullable(Type.String()),
  setupScript: Type.String(),
  variables: textMap,
});

export type SessionEnvironment = Wire<typeof sessionEnvironment>;

const assignment = Type.Object({
  sessionId: Type.String(),
  generation: integer,
  profile: Type.Object({ id: Type.String(), hash: Type.String() }),
  // The hash of the docs every Session gets as files (ADR 0052). Older
  // servers leave it out.
  docs: Type.Optional(Type.String()),
  workspace,
  // Whether the user trusts the repository's own Pi configuration in .pi, or
  // null when nobody was asked yet (ADR 0031).
  trusted: nullable(Type.Boolean()),
  model: nullable(modelRef),
  thinking: nullable(thinkingLevel),
  systemPrompt: nullable(Type.String()),
  firstMessage: nullable(Type.String()),
  plugins: strings,
  // Each plugin's settings when the Session started (ADR 0036). Older
  // servers leave it out, and Session parts get their defaults.
  pluginSettings: Type.Optional(Type.Record(Type.String(), pluginSettings)),
  // Session parts the Session must not run without, such as the meta
  // plugin's confirm. A runner that lacks one doesn't start it.
  requiredPlugins: Type.Optional(strings),
  // The installed plugins' Session parts, by name, with the SHA-256 of each
  // bundle. The runner fetches one it hasn't got (ADR 0022). They are
  // required too, so a runner from before them doesn't start the Session.
  installedParts: Type.Optional(textMap),
  environment: sessionEnvironment,
  // The git hosts the Session's owner connected (ADR 0043). Older servers
  // leave it out.
  gitLogins: Type.Optional(Type.Array(gitLogin)),
  // The Session last ran on another runner, so this one drops what it kept
  // of it and starts as a runner that never ran it (ADR 0032). Older servers
  // leave it out.
  fresh: Type.Optional(Type.Boolean()),
});

export type Assignment = Wire<typeof assignment>;

// A Session's own calls use its token, which reaches only that Session.
const sessionStart = Type.Object({
  ...assignment.properties,
  token: Type.String(),
});

export type SessionStart = Wire<typeof sessionStart>;

export const toolCall = Type.Object({
  generation: integer,
  id: Type.String(),
  name: Type.String(),
  input: Type.Unknown(),
});

export type ToolCall = Wire<typeof toolCall>;

const attempt = Type.Object({ sessionId: Type.String(), generation: integer });

export type Attempt = Wire<typeof attempt>;

export const workPoll = Type.Object({
  running: Type.Array(attempt),
  folders: strings,
  // The models logged in on the runner, and every model its providers
  // register, logged in or not (ADR 0044).
  models: Type.Array(modelRef),
  registeredModels: Type.Optional(Type.Array(modelRef)),
  // How many Sessions the runner takes at once. Absent means no limit.
  capacity: Type.Optional(Type.Integer({ minimum: 1 })),
  // A runner started for one Session, such as a pod on that Session's own
  // volume, takes only that Session, and that Session goes only to it.
  session: Type.Optional(Type.String()),
});

export type WorkPoll = Wire<typeof workPoll>;

const removal = Type.Object({
  sessionId: Type.String(),
  generation: integer,
  workspace,
  force: Type.Boolean(),
});

export type Removal = Wire<typeof removal>;

// A Session's start for logs. Only fields that hold no secrets or user text,
// so not its token, environment, git logins, prompts or plugin settings.
export function loggedStart({
  sessionId,
  generation,
  profile,
  model,
  thinking,
  plugins,
  workspace: started,
}: Assignment): Readonly<Record<string, unknown>> {
  return {
    sessionId,
    generation,
    profile,
    model,
    thinking,
    plugins,
    workspace: loggedWorkspace(started),
  };
}

function loggedWorkspace(logged: Workspace): Record<string, unknown> {
  switch (logged.kind) {
    case "folder":
      return { kind: logged.kind, path: logged.path };
    case "worktree":
      return { kind: logged.kind, path: logged.path, branch: logged.branch };
    case "clone":
      return {
        kind: logged.kind,
        repository: withoutUserinfo(logged.repository),
        branch: logged.branch,
      };
    case "repositories":
      return {
        kind: logged.kind,
        branch: logged.branch,
        repositories: logged.repositories.map(({ repository }) =>
          withoutUserinfo(repository),
        ),
      };
  }
}

// An scp-style git@host:path, which URL can't parse, has no password.
function withoutUserinfo(repository: string): string {
  const url = URL.parse(repository);
  if (url === null || (url.username === "" && url.password === "")) {
    return repository;
  }

  url.username = "";
  url.password = "";

  return url.href;
}

export const work = Type.Object({
  start: Type.Array(sessionStart),
  unload: Type.Array(attempt),
  remove: Type.Array(removal),
  // Every Profile's id, so runners can delete the folders of the others.
  profiles: strings,
});

export type Work = Wire<typeof work>;

// The server reads only that restore is a workspace with a kind; the runner
// that made it knows the rest.
const restore = Type.Unsafe<Workspace>(
  Type.Object({ kind: Type.String() }, { additionalProperties: true }),
);

const removalReport = Type.Union([
  // restore is the Workspace to prepare when the Session comes back, starting
  // from what the remotes still hold of its branch.
  Type.Object({ outcome: Type.Literal("removed"), restore }),
  // A kept workspace has restore when some of it was removed before the rest
  // failed, so what was removed can come back.
  Type.Object({
    outcome: Type.Literal("kept"),
    reason: Type.String(),
    restore: Type.Optional(restore),
  }),
]);

export type RemovalReport = Wire<typeof removalReport>;

// A report as the runner posts it, with the generation of the Removal it
// answers.
export const removalPost = Type.Intersect([
  removalReport,
  Type.Object({ generation: integer }),
]);

export type RemovalPost = Wire<typeof removalPost>;

export const trustAnswer = Type.Object({
  generation: integer,
  trusted: Type.Boolean(),
});

export type TrustAnswer = Wire<typeof trustAnswer>;

export const startFailure = Type.Object({
  generation: integer,
  error: Type.String(),
});

export type StartFailure = Wire<typeof startFailure>;

export const transcriptBatch = Type.Object({
  generation: integer,
  start: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  lines: strings,
});

export type TranscriptBatch = Wire<typeof transcriptBatch>;

export const transcriptAck = Type.Object({ acked: Type.Integer() });

export type TranscriptAck = Wire<typeof transcriptAck>;

export const livePost = Type.Object({
  generation: integer,
  events: Type.Array(postedEvent),
});

export type LivePost = Wire<typeof livePost>;
