import { Type } from "typebox";
import { nonEmpty, nullable, type Wire } from "./wire";

export const modelRef = Type.Object({
  provider: nonEmpty,
  id: nonEmpty,
});

export type ModelRef = Wire<typeof modelRef>;

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

export const repositoryCheckout = Type.Object({
  repository: repositoryUrl,
  startPoint: Type.Optional(startPoint),
});

export type RepositoryCheckout = Wire<typeof repositoryCheckout>;

// The directory a repository is checked out into inside a repositories
// Workspace: the last segment of its URL, without ".git". Undefined when that
// is "", "." or "..", which can't name a folder of its own.
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
export const isolations = ["process", "container"] as const;

export const isolation = Type.Enum(isolations);

export type Isolation = Wire<typeof isolation>;

export const activityStatus = Type.Enum(["idle", "running"]);

export type ActivityStatus = Wire<typeof activityStatus>;

export const sessionStatus = Type.Enum([
  "queued",
  "starting",
  "idle",
  "running",
  "interrupted",
  "failed",
  "stopped",
]);

export type SessionStatus = Wire<typeof sessionStatus>;

export const workspaceRemoval = Type.Enum([
  "pending",
  "forced",
  "removed",
  "kept",
]);

export type WorkspaceRemoval = Wire<typeof workspaceRemoval>;

// The plugin that started a Session and keeps it out of the Session list
// (ADR 0028), with the plugin's own key, such as a Project's id.
export const sessionOwner = Type.Object({
  plugin: Type.String(),
  key: Type.String(),
});

export type SessionOwner = Wire<typeof sessionOwner>;

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

export const session = Type.Object({
  id: Type.String(),
  environmentId: Type.String(),
  owner: nullable(sessionOwner),
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
