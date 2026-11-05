import { type TRecord, type TRefine, type TSchema, Type } from "typebox";
import { quote } from "./events";
import { runnerName } from "./runner";
import {
  isolation,
  modelRef,
  sessionAccess,
  thinkingLevel,
  workspaceRequest,
} from "./session";
import {
  anyMap,
  nonEmpty,
  nullable,
  strings,
  textMap,
  type Wire,
} from "./wire";

export const createSession = Type.Object({
  // Team work, which runs in a team Environment on a team Profile and
  // belongs to the team (ADR 0064).
  team: Type.Optional(Type.Boolean()),
  environment: Type.Optional(
    Type.String({ minLength: 1, description: "Environment id" }),
  ),
  profile: Type.Optional(
    Type.String({ minLength: 1, description: "Profile id" }),
  ),
  workspace: workspaceRequest,
  model: Type.Optional(modelRef),
  thinking: Type.Optional(thinkingLevel),
  systemPrompt: Type.Optional(Type.String()),
  firstMessage: Type.Optional(Type.String()),
});

export type CreateSession = Wire<typeof createSession>;

// A fork of a Session, or of it up to one of its messages.
export const forkSession = Type.Object({
  from: Type.Object({
    session: Type.String({ minLength: 1, description: "Session id" }),
    entry: Type.Optional(nonEmpty),
  }),
  environment: Type.Optional(nonEmpty),
  personal: Type.Optional(Type.Boolean()),
});

export type ForkSession = Wire<typeof forkSession>;

const said = Type.Refine(
  Type.String(),
  (value) => value.trim() !== "",
  () => "must not be empty",
);

// What moving personal work to the team takes: the handoff summary the team
// Session starts from, and optionally where it runs.
export const moveToTeam = Type.Object({
  from: Type.Object({
    session: Type.String({ minLength: 1, description: "Session id" }),
  }),
  owner: Type.Literal("team"),
  summary: said,
  environment: Type.Optional(nonEmpty),
  profile: Type.Optional(nonEmpty),
});

export type MoveToTeam = Wire<typeof moveToTeam>;

// A new Session, a fork of one, or personal work moved to the team: each
// makes a new Session. Each shape takes only its own fields, so a body fits
// the one it means.
export const newSession = Type.Union(
  [createSession, forkSession, moveToTeam].map((shape) =>
    Type.Object(shape.properties, { additionalProperties: false }),
  ) as [typeof createSession, typeof forkSession, typeof moveToTeam],
);

// What a person changes on a Session.
export const sessionChange = Type.Object({
  archived: Type.Optional(Type.Boolean()),
  access: Type.Optional(sessionAccess),
});

// A team Session message for people, not Pi (ADR 0065).
export const teamMessage = Type.Object({
  text: said,
  to: Type.Enum(["team", "aside"]),
  quote: Type.Optional(quote),
});

export type TeamMessage = Wire<typeof teamMessage>;

const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Well under Linux's limit on one environment string, so spawns don't fail.
const maxVariableBytes = 32 * 1024;

const variableValue = Type.Refine(
  Type.String(),
  (value) =>
    !value.includes("\0") && Buffer.byteLength(value) <= maxVariableBytes,
  () =>
    `must be a string of at most ${String(maxVariableBytes)} bytes without NUL`,
);

// Variables by name, such as API_URL.
function variables<Value extends TSchema>(
  value: Value,
): TRefine<TRecord<"^.*$", Value>> {
  return Type.Refine(
    Type.Record(Type.String(), value, { maxProperties: 200 }),
    (named) => Object.keys(named).every((name) => variableName.test(name)),
    (named) =>
      `has an invalid name: ${Object.keys(named).find((name) => !variableName.test(name)) ?? ""}`,
  );
}

export const createEnvironment = Type.Object({
  name: runnerName,
  template: Type.Optional(Type.String()),
  // The team's own, whose runners host only team work (ADR 0064). Only
  // admins make one.
  team: Type.Optional(Type.Boolean()),
});

export type CreateEnvironment = Wire<typeof createEnvironment>;

// A null secret removes it.
export const environmentUpdate = Type.Object({
  name: Type.Optional(said),
  isolation: Type.Optional(isolation),
  // A docker reference: no leading dash, so docker never reads it as a flag.
  image: Type.Optional(
    nullable(
      Type.String({
        pattern: "^[A-Za-z0-9][A-Za-z0-9._/:@-]*$",
        description: "Container image, or null for the default one",
      }),
    ),
  ),
  setupScript: Type.Optional(Type.String()),
  variables: Type.Optional(variables(variableValue)),
  secrets: Type.Optional(variables(nullable(variableValue))),
});

export type EnvironmentUpdate = Wire<typeof environmentUpdate>;

// The key is shown once. Runners that joined with an Environment's earlier
// key are let go. A join key makes an Environment for the runner that joins
// with it.
export const environmentKey = Type.Object({ key: Type.String() });

export type EnvironmentKey = Wire<typeof environmentKey>;

const runner = Type.Object({
  name: Type.String(),
  online: Type.Boolean(),
  capacity: nullable(Type.Integer()),
  running: Type.Integer(),
});

export type Runner = Wire<typeof runner>;

// Runners join an Environment's pool by its provider name (ADR 0032).
export const environment = Type.Object({
  id: Type.String(),
  name: Type.String(),
  provider: Type.String(),
  ownerId: Type.String(),
  createdAt: Type.String(),
  online: Type.Boolean(),
  // A plugin starts runners for it when a Session needs one, such as
  // Kubernetes pods, so it takes Sessions with no runner online (ADR 0040).
  onDemand: Type.Boolean(),
  // The plugin that starts its runners, such as kubernetes for pods.
  runnersFrom: nullable(Type.String()),
  runners: Type.Array(runner),
  folders: strings,
  // The models logged in on its online runners, and every model any of its
  // runners reported, kept after they go (ADR 0044).
  models: Type.Array(modelRef),
  // `provider/id` of models an admin keeps out of the model pickers.
  hiddenModels: strings,
  isolation,
  // Null runs containers from the default image.
  image: nullable(Type.String()),
  // Runs once on each machine, or in each image, before its first Session
  // (ADR 0032).
  setupScript: Type.String(),
  variables: textMap,
  // Secret values never leave the server except in a Session's assignment.
  secrets: strings,
  // Whether runners can join, which takes the Environment's key.
  hasKey: Type.Boolean(),
  // The admin's template it was made from, which sets its isolation, image
  // and setup script and the variables under its own (ADR 0049).
  templateId: nullable(Type.String()),
});

export type Environment = Wire<typeof environment>;

// A new Environment, with the key its runners join with, shown once.
export const createdEnvironment = Type.Object({
  ...environment.properties,
  key: Type.String(),
});

// What the UI says about an Environment: a runner is online, a plugin starts
// one when a Session needs it, or none can take a Session now (ADR 0040).
export function availability(
  of: Pick<Environment, "online" | "onDemand">,
): "Online" | "Starts runners on demand" | "Offline" {
  if (of.online) {
    return "Online";
  }

  return of.onDemand ? "Starts runners on demand" : "Offline";
}

// What an Environment is (ADR 0063): machines someone connects, a Docker
// image on such a machine, or pods on Kubernetes.
export type EnvironmentKind = "machine" | "docker" | "kubernetes";

export function kindOf(
  of: Pick<Environment, "runnersFrom" | "isolation">,
): EnvironmentKind {
  if (of.runnersFrom === "kubernetes") {
    return "kubernetes";
  }

  return of.isolation === "container" ? "docker" : "machine";
}

// A folder or file a repository's pipoca.json lists, at the commit last
// synced (ADR 0063).
const repositorySource = Type.Object({
  url: Type.String(),
  path: Type.String(),
  commit: Type.String(),
});

export type RepositorySource = Wire<typeof repositorySource>;

// What a repository's pipoca.json lists that can be imported (ADR 0063).
export const manifestEntry = Type.Object({
  name: Type.String(),
  path: Type.String(),
});

export type ManifestEntry = Wire<typeof manifestEntry>;

// What a repository's pipoca.json lists, by kind.
export const repositoryManifest = Type.Object({
  profiles: Type.Array(manifestEntry),
  templates: Type.Array(manifestEntry),
});

// Where a Profile or template comes from: a folder a repository's
// pipoca.json lists, or for a Profile the repository's root.
export const repositoryImport = Type.Object({
  source: Type.Object({
    url: Type.String(),
    path: Type.Optional(Type.String()),
  }),
});

// What admins share for people's Environments: settings, never secrets or
// runners (ADR 0049).
const environmentTemplate = Type.Object({
  id: Type.String(),
  name: Type.String(),
  isolation,
  image: nullable(Type.String()),
  setupScript: Type.String(),
  variables: textMap,
  // Model aliases for Environments made from it that have none of their
  // own, which the models plugin reads (ADR 0063).
  aliases: nullable(anyMap),
  // The repository file a synced template follows (ADR 0063).
  source: nullable(repositorySource),
});

export type EnvironmentTemplate = Wire<typeof environmentTemplate>;

// A template as the server lists it, with the plugin that starts runners for
// Environments made from it, if any.
export const listedTemplate = Type.Object({
  ...environmentTemplate.properties,
  runnersFrom: nullable(Type.String()),
});

export type ListedTemplate = Wire<typeof listedTemplate>;

// A Pi package source as Pi's settings take it, with Pi's optional filters
// for which of its resources load.
const piPackage = Type.Union([
  Type.String(),
  Type.Object({
    source: Type.String(),
    autoload: Type.Optional(Type.Boolean()),
    extensions: Type.Optional(strings),
    skills: Type.Optional(strings),
    prompts: Type.Optional(strings),
    themes: Type.Optional(strings),
  }),
]);

export type PiPackage = Wire<typeof piPackage>;

// What a Profile holds: a Pi agent directory without credentials (ADR 0031).
// An empty text leaves its file out.
export const profileContent = Type.Object({
  packages: Type.Array(piPackage, {
    description: "Pi packages, such as npm:pi-subagents",
  }),
  agentsMd: Type.String({ description: "AGENTS.md" }),
  systemMd: Type.String({ description: "SYSTEM.md, replacing Pi's" }),
  appendSystemMd: Type.String({ description: "APPEND_SYSTEM.md" }),
  mcpServers: anyMap,
  // Pi settings, such as defaultModel, other than packages.
  settings: Type.Record(Type.String(), Type.Unknown(), {
    description: "Pi settings",
  }),
});

export type ProfileContent = Wire<typeof profileContent>;

export const emptyProfile: ProfileContent = {
  packages: [],
  agentsMd: "",
  systemMd: "",
  appendSystemMd: "",
  mcpServers: {},
  settings: {},
};

// A Pi agent folder in the server's config folder, named by its id
// (ADR 0041).
export const profile = Type.Object({
  ...profileContent.properties,
  id: Type.String(),
  name: Type.String(),
  // Null for a Profile shared with every user, which only admins change.
  ownerId: nullable(Type.String()),
  // The Profile this one builds on, which it gets everything from (ADR 0063).
  buildsOn: nullable(Type.String()),
  // The repository folder a synced Profile follows. Null for one people edit.
  source: nullable(repositorySource),
  createdAt: Type.String(),
  // New Sessions use the default Profile when nothing else names one.
  isDefault: Type.Boolean(),
});

export type Profile = Wire<typeof profile>;

// The file a Profile is exported to and imported from.
export const profileExport = Type.Object({
  ...profileContent.properties,
  pipocaProfile: Type.Literal(1),
  name: Type.String(),
});

export type ProfileExport = Wire<typeof profileExport>;

export const uploadedFiles = Type.Object({ files: textMap });

// Pipoca's own file, and what each machine keeps for itself: logins,
// Session history and installed packages (ADR 0041).
const machineOwned = new Set([
  "profile.json",
  "auth.json",
  "models.json",
  "models-store.json",
  "sessions",
  "git",
  "npm",
  "tmp",
]);

// Whether a path, with / between its parts, is one a Profile folder holds.
export function profilePath(path: string): boolean {
  const parts = path.split("/");

  return (
    parts.every(
      (part) =>
        part !== "" &&
        part !== "." &&
        part !== ".." &&
        part !== "node_modules" &&
        part !== ".git" &&
        !part.endsWith(".tmp"),
    ) && !machineOwned.has(parts[0] ?? "")
  );
}

// A repository New Session offers (ADR 0043).
export const repositoryChoice = Type.Object({
  // What git clones.
  url: Type.String(),
  name: Type.String(),
  // The heading it is listed under, such as its host.
  group: Type.String(),
});

export type RepositoryChoice = Wire<typeof repositoryChoice>;

// Someone who can use the server, as admins list them on People.
// lastActive is when they last used the web app, to the minute.
export const person = Type.Object({
  id: Type.String(),
  name: Type.String(),
  admin: Type.Boolean(),
  settingUp: Type.Boolean(),
  lastActive: nullable(Type.String()),
});

export type Person = Wire<typeof person>;

export const personUpdate = Type.Object({ admin: Type.Boolean() });

// Who a user may name in team work, such as the people it is limited to.
export const teammate = Type.Object({ id: Type.String(), name: Type.String() });

export type Teammate = Wire<typeof teammate>;

// Everyone sees people's names; admins also see the rest.
export const personView = Type.Object({
  ...teammate.properties,
  ...Type.Partial(Type.Omit(person, ["id", "name"])).properties,
});

export type PersonView = Wire<typeof personView>;

// An admin's invite to the server (ADR 0063). One with an email lets that
// one person in once; one without is a link anyone may join with until it
// expires. An invited person gets in even where sign-in rules would refuse
// them, with the role the invite names.
export const invite = Type.Object({
  id: Type.String(),
  email: nullable(Type.String()),
  admin: Type.Boolean(),
  // The admin who made it.
  createdBy: Type.String(),
  createdAt: Type.String(),
  expiresAt: Type.String(),
  uses: Type.Integer(),
});

export type Invite = Wire<typeof invite>;

// A new invite with the token its link carries, shown once.
export const madeInvite = Type.Object({
  ...invite.properties,
  token: Type.String(),
});

export const inviteRequest = Type.Object({
  emails: Type.Optional(
    Type.Array(Type.String({ pattern: "^\\s*[^\\s@]+@[^\\s@]+\\s*$" }), {
      maxItems: 100,
    }),
  ),
  admin: Type.Optional(Type.Boolean()),
  days: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
});

// What the join page shows to someone who opened an invite's link.
export const joinInfo = Type.Object({
  email: nullable(Type.String()),
  admin: Type.Boolean(),
  // The name of the admin who invited them.
  invitedBy: Type.String(),
  expiresAt: Type.String(),
  passwordLogin: Type.Boolean(),
  // Sign-in links that carry the invite along.
  logins: Type.Array(
    Type.Object({ label: Type.String(), path: Type.String() }),
  ),
});

export type JoinInfo = Wire<typeof joinInfo>;

export const credentials = Type.Object({
  name: Type.String(),
  password: Type.String(),
});

// The person signed in, as sign-in answers.
export const user = Type.Object({
  id: Type.String(),
  name: Type.String(),
  admin: Type.Boolean(),
});

export type User = Wire<typeof user>;

export const signInStatus = Type.Object({
  user: nullable(user),
  // No one has an account yet, so the setup link makes the first.
  setup: Type.Boolean(),
  passwordLogin: Type.Boolean(),
  solo: Type.Boolean(),
  // Plugins' sign-in buttons, such as OIDC's.
  logins: Type.Array(
    Type.Object({ label: Type.String(), path: Type.String() }),
  ),
});

export type SignInStatus = Wire<typeof signInStatus>;

export const appLink = Type.Object({ link: Type.String() });

export const firstUser = Type.Object({
  ...credentials.properties,
  token: Type.String(),
});

export const appSignIn = Type.Object({
  challenge: Type.String(),
});

// Where a person is in the first-run setup (ADR 0063). Steps they dismissed
// stop showing as reminders on home.
export const setupState = Type.Object({
  finished: Type.Boolean(),
  dismissed: strings,
});

export type SetupState = Wire<typeof setupState>;

export const setupChange = Type.Union([
  Type.Object({ finished: Type.Literal(true) }),
  Type.Object({ dismiss: nonEmpty }),
]);

// Null until the person pins or unpins a page.
export const pinnedPages = Type.Object({ pages: nullable(strings) });

export const pinnedPagesChange = Type.Object({ pages: strings });

export const accessTokenRequest = Type.Object({ name: Type.String() });

// A personal token for MCP clients (ADR 0035). Its secret is shown once.
export const accessToken = Type.Object({
  id: Type.String(),
  name: Type.String(),
  createdAt: Type.String(),
});

export type AccessToken = Wire<typeof accessToken>;

export const createdAccessToken = Type.Object({
  ...accessToken.properties,
  secret: Type.String(),
});

export const health = Type.Object({
  status: Type.String(),
  version: Type.String(),
  pi: Type.String(),
  // When this run of the server started, to tell it from the next.
  started: Type.String(),
});

export const restartRequest = Type.Object({
  force: Type.Optional(Type.Boolean()),
});

// The text read and the version it had, so a write never overwrites a
// change made since.
export const configFileWrite = Type.Object({
  text: Type.String(),
  version: nullable(Type.String()),
});

const configEntry = Type.Object({
  name: Type.String(),
  locked: Type.Boolean(),
});

export const configFiles = Type.Object({
  root: Type.String(),
  files: Type.Array(configEntry),
});

export const configFile = Type.Object({
  ...configEntry.properties,
  text: Type.String(),
  version: nullable(Type.String()),
});

export type ConfigFile = Wire<typeof configFile>;

// A file in a Profile's folder.
export const profileEntry = Type.Object({
  path: Type.String(),
  size: Type.Integer(),
});

const trimmedUpTo = (most: number) =>
  Type.Refine(
    Type.String(),
    (value) => value.trim().length <= most,
    () => `must be at most ${String(most)} characters`,
  );

// A page of the team hub: the panels plugins give it, in order, each as
// "<plugin>/<panel>". Admins lay them out in pipoca.json (ADR 0067).
const hubPage = Type.Object({
  id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,39}$" }),
  title: Type.Refine(
    trimmedUpTo(60),
    (value) => value.trim() !== "",
    () => "must not be empty",
  ),
  panels: Type.Array(
    Type.String({ pattern: "^[a-z0-9][a-z0-9-]*/[A-Za-z0-9][A-Za-z0-9_-]*$" }),
    { maxItems: 30 },
  ),
});

export type HubPage = Wire<typeof hubPage>;

// Null until an admin lays out the hub, which then shows every panel on Home.
export const hubLayout = Type.Object({
  pages: nullable(
    Type.Refine(
      Type.Array(hubPage, { maxItems: 20 }),
      (pages) =>
        pages[0]?.id === "home" &&
        new Set(pages.map(({ id }) => id)).size === pages.length,
      () => 'must start with "home" and give each page its own id',
    ),
  ),
});

export type HubLayout = Wire<typeof hubLayout>;

// The team's own name, which admins set, or null while it has none.
export const teamName = Type.Object({ name: nullable(trimmedUpTo(60)) });

export type TeamName = Wire<typeof teamName>;

export const teamNameChange = Type.Partial(teamName);

// The team as the server reads it, with how many of its messages since its
// last turn Pi reads (ADR 0065).
export const teamView = Type.Object({
  ...teamName.properties,
  messagesRead: Type.Integer({ minimum: 1 }),
});

export type TeamView = Wire<typeof teamView>;

// What admins set up for people who join (ADR 0063): the Environment
// template they get one from, the shared Profiles they pick from, and the
// setup steps they can't skip.
export const newcomers = Type.Object({
  template: nullable(Type.String()),
  profiles: Type.Array(Type.String(), { maxItems: 20 }),
  required: strings,
});

export type Newcomers = Wire<typeof newcomers>;

export const newcomersChange = Type.Partial(newcomers);
