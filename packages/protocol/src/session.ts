import { Type } from "typebox";
import { nonEmpty, nullable, strings, type Wire } from "./wire";

export const modelRef = Type.Object({
  provider: nonEmpty,
  id: nonEmpty,
});

export type ModelRef = Wire<typeof modelRef>;

// "provider/id", as Pi's --model takes it. Provider names have no slash,
// but some model ids do.
export function modelRefOf(name: string): ModelRef | undefined {
  const slash = name.indexOf("/");

  return slash > 0 && slash < name.length - 1
    ? { provider: name.slice(0, slash), id: name.slice(slash + 1) }
    : undefined;
}

export function modelName({ provider, id }: ModelRef): string {
  return `${provider}/${id}`;
}

// A model as its provider registers it, to show it by name with what it
// takes, in the model pickers.
export const modelInfo = Type.Object({
  ...modelRef.properties,
  name: Type.Optional(Type.String()),
  contextWindow: Type.Optional(Type.Number()),
  reasoning: Type.Optional(Type.Boolean()),
});

export type ModelInfo = Wire<typeof modelInfo>;

// Only what the pickers show of a provider's model, which carries much more.
export function modelInfoOf({
  provider,
  id,
  name,
  contextWindow,
  reasoning,
}: ModelInfo): ModelInfo {
  return {
    provider,
    id,
    ...(name !== undefined && name !== id && { name }),
    ...(contextWindow !== undefined && { contextWindow }),
    ...(reasoning !== undefined && { reasoning }),
  };
}

// Pi's reasoning levels, from none to the most a model allows.
export const thinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const thinkingLevel = Type.Enum(thinkingLevels);

export type ThinkingLevel = Wire<typeof thinkingLevel>;

export const actor = Type.Union([
  Type.TemplateLiteral("user:${string}"),
  Type.TemplateLiteral("session:${string}"),
  Type.TemplateLiteral("plugin:${string}"),
]);

export type Actor = Wire<typeof actor>;

// Who a record belongs to: one person, or the server's one team (ADR 0064).
export const owner = Type.Union([
  Type.TemplateLiteral("person:${string}"),
  Type.Literal("team"),
]);

export type Owner = Wire<typeof owner>;

// A leading dash would reach git as an option.
const startPoint = Type.String({
  pattern: "^[^-]",
  description: "A branch, tag or commit",
});

const repositoryUrl = Type.Refine(
  nonEmpty,
  (repository) => !holdsCredentials(repository),
  () => "can't hold credentials: connect the git host instead",
);

// A token or password in a URL would be stored with the Session and logged.
// An ssh user name alone, such as git@, is not a credential.
function holdsCredentials(repository: string): boolean {
  const url = URL.parse(repository);

  return (
    url !== null &&
    (url.password !== "" ||
      (url.username !== "" && url.protocol.startsWith("http")))
  );
}

const repositoryCheckout = Type.Object({
  repository: repositoryUrl,
  startPoint: Type.Optional(startPoint),
});

// The directory a repository is checked out into inside a repositories
// Workspace: the last segment of its URL, without ".git". Undefined when that
// is "", "." or "..", which can't name a folder of its own.
// The folders and repositories Sessions on the Environment used last,
// newest first.
export function recentPlaces(
  sessions: readonly Session[],
  environmentId: string | undefined,
): string[] {
  const places = [...sessions]
    .filter((session) => session.environmentId === environmentId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .flatMap(({ workspace }) => {
      switch (workspace.kind) {
        case "folder":
        case "worktree":
          return [workspace.path];
        case "clone":
          return [workspace.repository];
        case "repositories":
          return workspace.repositories.map(({ repository }) => repository);
      }
    });

  return [...new Set(places)].slice(0, 5);
}

export function checkoutName(repository: string): string | undefined {
  const name = repository
    .replace(/[/\\]+$/, "")
    .split(/[/:\\]/)
    .at(-1)
    ?.replace(/\.git$/, "");

  return name === "" || name === "." || name === ".." ? undefined : name;
}

// What a removal records to bring a session branch back (ADR 0013). Only the
// provider sets it, so a WorkspaceRequest has none.
const restorable = {
  // The remote branch or commit that held the branch's work. Once no remote
  // has it, the branch starts over from startPoint.
  restorePoint: Type.Optional(Type.String()),
  // The pipoca* keys of the branch's git config by name, such as the commit
  // it started from and its pull request (ADR 0021). They come back with the
  // branch, but not when it starts over.
  branchConfig: Type.Optional(Type.Record(Type.String(), Type.String())),
};

// startPoint is the branch of the Session this one forked from, which a
// fresh clone gets only from the remote. Only the server sets it, so no
// request has it.
const forked = { forked: Type.Optional(Type.Boolean()) };

const folder = Type.Object({ kind: Type.Literal("folder"), path: nonEmpty });

export const workspace = Type.Union([
  folder,
  Type.Object({
    kind: Type.Literal("worktree"),
    path: Type.String(),
    branch: Type.String(),
    startPoint: Type.Optional(Type.String()),
    ...restorable,
  }),
  Type.Object({
    kind: Type.Literal("clone"),
    repository: Type.String(),
    branch: Type.String(),
    startPoint: Type.Optional(Type.String()),
    ...forked,
    ...restorable,
  }),
  Type.Object({
    kind: Type.Literal("repositories"),
    repositories: Type.Array(
      Type.Object({
        repository: Type.String(),
        startPoint: Type.Optional(Type.String()),
        ...forked,
        ...restorable,
      }),
    ),
    branch: Type.String(),
  }),
]);

export type Workspace = Wire<typeof workspace>;

const distinctCheckouts = Type.Refine(
  Type.Array(repositoryCheckout, { minItems: 1 }),
  (checkouts) => {
    const names = checkouts.map((c) => checkoutName(c.repository));

    return !names.includes(undefined) && new Set(names).size === names.length;
  },
  () => "need different names",
);

export const workspaceRequest = Type.Union(
  [
    folder,
    Type.Object({
      kind: Type.Literal("worktree"),
      path: nonEmpty,
      startPoint: Type.Optional(startPoint),
    }),
    Type.Object({
      kind: Type.Literal("clone"),
      repository: repositoryUrl,
      startPoint: Type.Optional(startPoint),
    }),
    Type.Object({
      kind: Type.Literal("repositories"),
      repositories: distinctCheckouts,
    }),
  ],
  {
    description:
      "A folder or worktree on a runner's machine (path), a clone of one repository, or several repositories side by side",
  },
);

export type WorkspaceRequest = Wire<typeof workspaceRequest>;

export function movable({ kind }: Workspace): boolean {
  return kind === "clone" || kind === "repositories";
}

// The repository a workspace's project trust is kept for: a clone's URL or a
// local checkout's path. A repositories Workspace runs Pi in a folder of
// checkouts, which has no .pi of its own.
export function trustedRepository(trusted: Workspace): string | undefined {
  switch (trusted.kind) {
    case "clone":
      return trusted.repository;
    case "folder":
    case "worktree":
      return trusted.path;
    case "repositories":
      return undefined;
  }
}

// A Session runs as a process on its runner's machine, or as a process in a
// container from the Environment's image (ADR 0032).
const isolations = ["process", "container"] as const;

export const isolation = Type.Enum(isolations);

export const activityStatus = Type.Enum(["idle", "running"]);

const sessionStatus = Type.Enum([
  "queued",
  "starting",
  "idle",
  "running",
  "interrupted",
  "failed",
  "stopped",
]);

export type SessionStatus = Wire<typeof sessionStatus>;

// Waiting for a runner, starting on one, or working: a Session someone may
// still want to stop, and that settles once this is false.
export function isBusy(status: SessionStatus): boolean {
  return status === "queued" || status === "starting" || status === "running";
}

export const workspaceRemoval = Type.Enum([
  "pending",
  "forced",
  "removed",
  "kept",
]);

export type WorkspaceRemoval = Wire<typeof workspaceRemoval>;

// The plugin that started a Session and keeps it out of the Session list
// (ADR 0028), with the plugin's own key, such as a Project's id.
const sessionPlugin = Type.Object({
  id: Type.String(),
  key: Type.String(),
});

export type SessionPlugin = Wire<typeof sessionPlugin>;

// Who may see and steer a team Session (ADR 0064): every user, every user
// seeing it but only its starter steering, or its starter and named people.
export const sessionAccess = Type.Union([
  Type.Object({ kind: Type.Literal("team") }),
  Type.Object({ kind: Type.Literal("view") }),
  Type.Object({
    kind: Type.Literal("named"),
    people: Type.Array(Type.String()),
  }),
]);

export type SessionAccess = Wire<typeof sessionAccess>;

export const actsAs = Type.Object({
  plugin: Type.String(),
  name: Type.String(),
});

export type ActsAs = Wire<typeof actsAs>;

// The agent a Session starts as (ADR 0075), which a Session part finds by
// name. Its tools limit Pi's, and the tools in keep stay whatever it names.
export const startAgent = Type.Object({
  name: nonEmpty,
  keep: strings,
});

export type StartAgent = Wire<typeof startAgent>;

export const session = Type.Object({
  id: Type.String(),
  environmentId: Type.String(),
  plugin: nullable(sessionPlugin),
  provider: Type.String(),
  // The runner that claimed the Session last, null until one does.
  runner: nullable(Type.String()),
  // Fixed when the Session is created (ADR 0031).
  profileId: Type.String(),
  workspace,
  model: nullable(modelRef),
  // The reasoning level a new Session starts at. Pi keeps later changes.
  thinking: nullable(thinkingLevel),
  systemPrompt: nullable(Type.String()),
  firstMessage: nullable(Type.String()),
  agent: nullable(startAgent),
  // The name Pi gave the session, or else the first thing the user said.
  title: nullable(Type.String()),
  status: sessionStatus,
  generation: Type.Integer(),
  createdAt: Type.String(),
  interruptedAt: nullable(Type.String()),
  error: nullable(Type.String()),
  archivedAt: nullable(Type.String()),
  workspaceRemoval: nullable(workspaceRemoval),
  // Why the provider kept the workspace, while workspaceRemoval is "kept".
  workspaceKeptReason: nullable(Type.String()),
  // The user who started the Session, or the one who started the Session
  // that started it. Its runner signs git in as them (ADR 0043).
  startedBy: nullable(Type.String()),
  // The identity its git acts as instead of startedBy, such as a GitHub App
  // a plugin's work runs as (ADR 0060). The plugin it names resolves it.
  actsAs: nullable(actsAs),
  // Its git reads but can't push, and it gets no tools that post outside,
  // such as a routine run fired by outside input (ADR 0076).
  proposes: Type.Boolean(),
  ownedBy: owner,
  // A personal Session's is always team, since only its person reaches it.
  access: sessionAccess,
  online: Type.Boolean(),
  // Pi asked a question and waits for a person to answer it (ADR 0025).
  waiting: Type.Boolean(),
});

export type Session = Wire<typeof session>;

// A fork from a user message gives back that message's text for the new
// Session's composer, as Pi's /fork puts it back in its editor.
export const forkedSession = Type.Object({
  ...session.properties,
  editorText: Type.Optional(Type.String()),
});

export type ForkedSession = Wire<typeof forkedSession>;
