import { Type } from "typebox";
import {
  accessToken,
  accessTokenRequest,
  appLink,
  appSignIn,
  configFile,
  configFiles,
  configFileWrite,
  createdAccessToken,
  createdEnvironment,
  createEnvironment,
  credentials,
  environment,
  environmentKey,
  environmentUpdate,
  firstUser,
  health,
  hubLayout,
  invite,
  inviteRequest,
  joinInfo,
  listedTemplate,
  madeInvite,
  newcomers,
  newcomersChange,
  newSession,
  person,
  personUpdate,
  personView,
  pinnedPages,
  pinnedPagesChange,
  profile,
  profileContent,
  profileEntry,
  repositoryManifest,
  restartRequest,
  sessionChange,
  setupChange,
  setupState,
  signInStatus,
  teamMessage,
  teamName,
  teamNameChange,
  teamView,
  uploadedFiles,
  user,
} from "./browser";
import { browserCommand } from "./events";
import {
  pluginFileContent,
  pluginConfig,
  pluginInfo,
  pluginInstall,
  pluginUpdate,
  toolSpec,
} from "./plugins";
import type { RouteSpec } from "./route";
import {
  joined,
  joinRequest,
  livePost,
  profileFiles,
  removalPost,
  startFailure,
  toolCall,
  transcriptAck,
  transcriptBatch,
  trustAnswer,
  work,
  workPoll,
} from "./runner";
import { forkedSession, session } from "./session";
import { strings } from "./wire";

const any = Type.Unknown();
const generation = Type.Object({ generation: Type.Integer() });

// Mine are a person's own, the team's are everyone's, and all is everyone's
// own as well, for admins.
const scope = Type.Optional(Type.Enum(["mine", "team", "all"]));

// The layers under every Profile, which work alike: the admin's base
// Profile (ADR 0044) and each person's My defaults (ADR 0063).
function layer<const Path extends string>(path: Path) {
  const files = `${path}/files` as const;
  const file = `${path}/files/*path` as const;

  return {
    get: { method: "GET", path, auth: "person", response: profileContent },
    update: {
      method: "PUT",
      path,
      auth: "person",
      body: any,
      response: profileContent,
      changes: ["profiles"],
    },
    files: {
      method: "GET",
      path: files,
      auth: "person",
      response: Type.Array(profileEntry),
    },
    upload: {
      method: "POST",
      path: files,
      auth: "person",
      body: uploadedFiles,
      status: 204,
      changes: ["profiles"],
    },
    file: { method: "GET", path: file, auth: "person", response: "bytes" },
    write: {
      method: "PUT",
      path: file,
      auth: "person",
      body: "bytes",
      status: 204,
      changes: ["profiles"],
    },
    remove: {
      method: "DELETE",
      path: file,
      auth: "person",
      status: 204,
      changes: ["profiles"],
    },
  } as const;
}

const base = layer("/api/settings/base-profile");
const defaults = layer("/api/me/profile-defaults");

// Every route the server answers: /api for people and /runner for runners
// and the Session hosts they start. The server gives each a handler; the
// web app, runners, the CLI and toolsets call them by name.
export const routes = {
  health: { method: "GET", path: "/healthz", auth: "public", response: health },
  // MCP clients sign in with an access token of their own (ADR 0035).
  mcp: { method: "ANY", path: "/api/mcp", auth: "public" },
  changes: {
    method: "GET",
    path: "/api/changes",
    auth: "person",
    response: "stream",
  },
  "server.restart": {
    method: "POST",
    path: "/api/server/restart",
    auth: "admin",
    body: restartRequest,
    status: 202,
  },

  "auth.status": {
    method: "GET",
    path: "/api/auth",
    auth: "public",
    response: signInStatus,
  },
  "auth.setup": {
    method: "POST",
    path: "/api/auth/setup",
    auth: "public",
    body: firstUser,
    response: user,
    status: 201,
  },
  "auth.session.create": {
    method: "POST",
    path: "/api/auth/session",
    auth: "public",
    body: credentials,
    response: user,
  },
  "auth.session.remove": {
    method: "DELETE",
    path: "/api/auth/session",
    auth: "public",
    status: 204,
  },
  "auth.invite": {
    method: "GET",
    path: "/api/auth/invites/:token",
    auth: "public",
    response: joinInfo,
  },
  "auth.invite.accept": {
    method: "POST",
    path: "/api/auth/invites/:token",
    auth: "public",
    body: credentials,
    response: user,
    status: 201,
    changes: ["people", "environments"],
  },
  // Redeemed on GET, since it is a link a browser opens.
  "auth.link": {
    method: "GET",
    path: "/api/auth/links/:token",
    auth: "public",
    query: Type.Object({ verifier: Type.Optional(Type.String()) }),
    status: 303,
  },
  "auth.appLinks.create": {
    method: "POST",
    path: "/api/auth/app-links",
    auth: "person",
    body: appSignIn,
    response: appLink,
  },

  "me.setup": {
    method: "GET",
    path: "/api/me/setup",
    auth: "person",
    response: setupState,
  },
  "me.setup.update": {
    method: "PATCH",
    path: "/api/me/setup",
    auth: "person",
    body: setupChange,
    response: setupState,
  },
  "me.pinnedPages": {
    method: "GET",
    path: "/api/me/pinned-pages",
    auth: "person",
    response: pinnedPages,
  },
  "me.pinnedPages.update": {
    method: "PUT",
    path: "/api/me/pinned-pages",
    auth: "person",
    body: pinnedPagesChange,
    response: pinnedPages,
  },
  "me.accessTokens": {
    method: "GET",
    path: "/api/me/access-tokens",
    auth: "person",
    response: Type.Array(accessToken),
  },
  "me.accessTokens.create": {
    method: "POST",
    path: "/api/me/access-tokens",
    auth: "person",
    body: accessTokenRequest,
    response: createdAccessToken,
    status: 201,
    changes: ["access-tokens"],
  },
  "me.accessTokens.remove": {
    method: "DELETE",
    path: "/api/me/access-tokens/:id",
    auth: "person",
    status: 204,
    changes: ["access-tokens"],
  },
  "me.profileDefaults": defaults.get,
  "me.profileDefaults.update": defaults.update,
  "me.profileDefaults.files": defaults.files,
  "me.profileDefaults.files.upload": defaults.upload,
  "me.profileDefaults.file": defaults.file,
  "me.profileDefaults.file.write": defaults.write,
  "me.profileDefaults.file.remove": defaults.remove,

  "settings.team": {
    method: "GET",
    path: "/api/settings/team",
    auth: "person",
    response: teamView,
  },
  "settings.team.update": {
    method: "PUT",
    path: "/api/settings/team",
    auth: "admin",
    body: teamNameChange,
    response: teamName,
    changes: ["team"],
  },
  "settings.hub": {
    method: "GET",
    path: "/api/settings/hub",
    auth: "person",
    response: hubLayout,
  },
  "settings.hub.update": {
    method: "PUT",
    path: "/api/settings/hub",
    auth: "admin",
    body: hubLayout,
    response: hubLayout,
    changes: ["hub"],
  },
  "settings.newcomers": {
    method: "GET",
    path: "/api/settings/newcomers",
    auth: "person",
    response: newcomers,
  },
  "settings.newcomers.update": {
    method: "PUT",
    path: "/api/settings/newcomers",
    auth: "admin",
    body: newcomersChange,
    response: newcomers,
    changes: ["newcomers"],
  },
  "settings.config": {
    method: "GET",
    path: "/api/settings/config",
    auth: "admin",
    response: configFiles,
  },
  "settings.config.file": {
    method: "GET",
    path: "/api/settings/config/files/:name",
    auth: "admin",
    response: configFile,
  },
  "settings.config.file.write": {
    method: "PUT",
    path: "/api/settings/config/files/:name",
    auth: "admin",
    body: configFileWrite,
    response: configFile,
  },
  "settings.baseProfile": base.get,
  "settings.baseProfile.update": base.update,
  "settings.baseProfile.files": base.files,
  "settings.baseProfile.files.upload": base.upload,
  "settings.baseProfile.file": base.file,
  "settings.baseProfile.file.write": base.write,
  "settings.baseProfile.file.remove": base.remove,

  "people.list": {
    method: "GET",
    path: "/api/people",
    auth: "person",
    response: Type.Array(personView),
  },
  "people.update": {
    method: "PATCH",
    path: "/api/people/:id",
    auth: "admin",
    body: personUpdate,
    response: person,
    changes: ["people"],
  },
  "invites.list": {
    method: "GET",
    path: "/api/invites",
    auth: "admin",
    response: Type.Array(invite),
  },
  "invites.create": {
    method: "POST",
    path: "/api/invites",
    auth: "admin",
    body: inviteRequest,
    response: Type.Array(madeInvite),
    status: 201,
    changes: ["people"],
  },
  "invites.remove": {
    method: "DELETE",
    path: "/api/invites/:id",
    auth: "admin",
    status: 204,
    changes: ["people"],
  },

  "plugins.list": {
    method: "GET",
    path: "/api/plugins",
    auth: "person",
    response: Type.Array(pluginInfo),
  },
  "plugins.install": {
    method: "POST",
    path: "/api/plugins",
    auth: "admin",
    body: pluginInstall,
    response: pluginInfo,
    status: 201,
    changes: ["plugins"],
    long: true,
  },
  "plugins.update": {
    method: "PATCH",
    path: "/api/plugins/:plugin",
    auth: "admin",
    body: pluginUpdate,
    response: pluginInfo,
    changes: ["plugins"],
    long: true,
  },
  "plugins.remove": {
    method: "DELETE",
    path: "/api/plugins/:plugin",
    auth: "admin",
    status: 204,
    changes: ["plugins"],
  },
  // An in-place plugin's files (ADR 0052).
  "plugins.files": {
    method: "GET",
    path: "/api/plugins/:plugin/files",
    auth: "person",
    response: strings,
  },
  "plugins.file": {
    method: "GET",
    path: "/api/plugins/:plugin/files/*path",
    auth: "person",
    response: Type.Object({ path: Type.String(), content: Type.String() }),
  },
  "plugins.file.write": {
    method: "PUT",
    path: "/api/plugins/:plugin/files/*path",
    auth: "person",
    body: pluginFileContent,
    response: pluginInfo,
    changes: ["plugins"],
  },
  "plugins.builds.create": {
    method: "POST",
    path: "/api/plugins/:plugin/builds",
    auth: "person",
    response: pluginInfo,
    status: 201,
    changes: ["plugins"],
    long: true,
  },
  // Its tables, emptied when its schema changed (ADR 0068).
  "plugins.data.remove": {
    method: "DELETE",
    path: "/api/plugins/:plugin/data",
    auth: "admin",
    response: pluginInfo,
    changes: ["plugins"],
  },
  // A defined plugin's config, its secrets sealed or named (ADR 0039).
  "plugins.config": {
    method: "GET",
    path: "/api/plugins/:plugin/config",
    auth: "admin",
    response: pluginConfig,
  },
  "plugins.config.update": {
    method: "PUT",
    path: "/api/plugins/:plugin/config",
    auth: "admin",
    body: Type.Object({ value: Type.Unknown() }),
    response: pluginConfig,
    changes: ["plugins"],
  },
  "plugins.part": {
    method: "GET",
    path: "/api/plugins/:plugin/parts/:file",
    auth: "person",
    response: "bytes",
  },
  // Each plugin's own API: its public routes, then those for people signed
  // in (ADR 0015).
  ext: { method: "ANY", path: "/api/ext/:plugin/*path", auth: "public" },

  "environments.list": {
    method: "GET",
    path: "/api/environments",
    auth: "person",
    query: Type.Object({ scope }),
    response: Type.Array(environment),
  },
  "environments.create": {
    method: "POST",
    path: "/api/environments",
    auth: "person",
    body: createEnvironment,
    response: createdEnvironment,
    status: 201,
    changes: ["environments"],
  },
  "environments.update": {
    method: "PATCH",
    path: "/api/environments/:id",
    auth: "person",
    body: environmentUpdate,
    response: environment,
    changes: ["environments"],
  },
  "environments.remove": {
    method: "DELETE",
    path: "/api/environments/:id",
    auth: "person",
    status: 204,
    changes: ["environments"],
  },
  // A new key, which lets go of runners that joined with the one before.
  "environments.keys.create": {
    method: "POST",
    path: "/api/environments/:id/keys",
    auth: "person",
    response: environmentKey,
    status: 201,
    changes: ["environments"],
  },
  "joinKeys.create": {
    method: "POST",
    path: "/api/join-keys",
    auth: "person",
    response: environmentKey,
    status: 201,
  },
  "environmentTemplates.list": {
    method: "GET",
    path: "/api/environment-templates",
    auth: "person",
    response: Type.Array(listedTemplate),
  },
  // A template's settings, or { source } to import one a repository lists.
  "environmentTemplates.create": {
    method: "POST",
    path: "/api/environment-templates",
    auth: "admin",
    body: any,
    response: listedTemplate,
    status: 201,
    changes: ["environments"],
    long: true,
  },
  "environmentTemplates.update": {
    method: "PATCH",
    path: "/api/environment-templates/:id",
    auth: "admin",
    body: any,
    response: listedTemplate,
    changes: ["environments"],
  },
  "environmentTemplates.remove": {
    method: "DELETE",
    path: "/api/environment-templates/:id",
    auth: "admin",
    status: 204,
    changes: ["environments"],
  },
  // Reads its repository again now, rather than at the next sync.
  "environmentTemplates.syncs.create": {
    method: "POST",
    path: "/api/environment-templates/:id/syncs",
    auth: "admin",
    response: listedTemplate,
    status: 201,
    changes: ["environments"],
    long: true,
  },
  // What a repository's pipoca.json lists, to pick from (ADR 0063).
  "repositories.manifest": {
    method: "GET",
    path: "/api/repositories/manifest",
    auth: "person",
    query: Type.Object({ url: Type.String() }),
    response: repositoryManifest,
    long: true,
  },

  "profiles.list": {
    method: "GET",
    path: "/api/profiles",
    auth: "person",
    query: Type.Object({ scope: Type.Optional(Type.Enum(["mine", "team"])) }),
    response: Type.Array(profile),
  },
  // A Profile's content, an exported Profile file, { from } to copy a
  // Profile, or { source } to import one from a repository.
  "profiles.create": {
    method: "POST",
    path: "/api/profiles",
    auth: "person",
    body: any,
    response: profile,
    status: 201,
    changes: ["profiles"],
    long: true,
  },
  // An exported archive, as GET /api/profiles/:id/archive gives it.
  "profiles.archives.create": {
    method: "POST",
    path: "/api/profiles/archives",
    auth: "person",
    query: Type.Object({ name: Type.Optional(Type.String()) }),
    body: "bytes",
    response: profile,
    status: 201,
    changes: ["profiles"],
  },
  "profiles.get": {
    method: "GET",
    path: "/api/profiles/:id",
    auth: "person",
    response: profile,
  },
  // Its content, and isDefault: true to make it the default.
  "profiles.update": {
    method: "PATCH",
    path: "/api/profiles/:id",
    auth: "person",
    body: any,
    response: profile,
    changes: ["profiles"],
  },
  "profiles.remove": {
    method: "DELETE",
    path: "/api/profiles/:id",
    auth: "person",
    status: 204,
    changes: ["profiles"],
  },
  "profiles.syncs.create": {
    method: "POST",
    path: "/api/profiles/:id/syncs",
    auth: "person",
    response: profile,
    status: 201,
    changes: ["profiles"],
    long: true,
  },
  "profiles.archive": {
    method: "GET",
    path: "/api/profiles/:id/archive",
    auth: "person",
    response: "bytes",
  },
  "profiles.files": {
    method: "GET",
    path: "/api/profiles/:id/files",
    auth: "person",
    response: Type.Array(profileEntry),
  },
  // Files and folders as { files: { path: base64 } }, the way runners get
  // them.
  "profiles.files.upload": {
    method: "POST",
    path: "/api/profiles/:id/files",
    auth: "person",
    body: uploadedFiles,
    status: 204,
    changes: ["profiles"],
  },
  "profiles.file": {
    method: "GET",
    path: "/api/profiles/:id/files/*path",
    auth: "person",
    response: "bytes",
  },
  "profiles.file.write": {
    method: "PUT",
    path: "/api/profiles/:id/files/*path",
    auth: "person",
    body: "bytes",
    status: 204,
    changes: ["profiles"],
  },
  "profiles.file.remove": {
    method: "DELETE",
    path: "/api/profiles/:id/files/*path",
    auth: "person",
    status: 204,
    changes: ["profiles"],
  },

  // A plugin's own Sessions show only inside it unless plugins is true
  // (ADR 0028).
  "sessions.list": {
    method: "GET",
    path: "/api/sessions",
    auth: "person",
    query: Type.Object({
      scope,
      archived: Type.Optional(Type.Boolean()),
      plugins: Type.Optional(Type.Boolean()),
    }),
    response: Type.Array(session),
  },
  "sessions.create": {
    method: "POST",
    path: "/api/sessions",
    auth: "person",
    body: newSession,
    response: forkedSession,
    status: 201,
  },
  "sessions.get": {
    method: "GET",
    path: "/api/sessions/:id",
    auth: "person",
    response: session,
  },
  "sessions.update": {
    method: "PATCH",
    path: "/api/sessions/:id",
    auth: "person",
    body: sessionChange,
    response: session,
  },
  // Removes a workspace the runner kept, even when it would lose work.
  "sessions.workspace.remove": {
    method: "DELETE",
    path: "/api/sessions/:id/workspace",
    auth: "person",
    response: session,
  },
  "sessions.events": {
    method: "GET",
    path: "/api/sessions/:id/events",
    auth: "person",
    response: "stream",
  },
  // A team Session message for people, not Pi (ADR 0065).
  "sessions.messages.create": {
    method: "POST",
    path: "/api/sessions/:id/messages",
    auth: "person",
    body: teamMessage,
    status: 201,
  },
  "sessions.commands.create": {
    method: "POST",
    path: "/api/sessions/:id/commands",
    auth: "person",
    body: browserCommand,
    status: 202,
  },
  // Who watches the Session, as a stream, and who types.
  "sessions.presence": {
    method: "GET",
    path: "/api/sessions/:id/presence",
    auth: "person",
    response: "stream",
  },
  "sessions.presence.typing": {
    method: "POST",
    path: "/api/sessions/:id/presence",
    auth: "person",
    status: 204,
  },

  "runner.join": {
    method: "POST",
    path: "/runner/join",
    auth: "public",
    body: joinRequest,
    response: joined,
  },
  // A long poll for Sessions to start, unload and remove (ADR 0032).
  "runner.work": {
    method: "POST",
    path: "/runner/work",
    auth: "runner",
    body: workPoll,
    response: work,
  },
  "runner.transcript": {
    method: "GET",
    path: "/runner/sessions/:id/transcript",
    auth: "session",
    response: Type.Object({ entries: strings }),
  },
  "runner.transcript.append": {
    method: "POST",
    path: "/runner/sessions/:id/transcript",
    auth: "session",
    body: transcriptBatch,
    response: transcriptAck,
  },
  "runner.startFailure": {
    method: "POST",
    path: "/runner/sessions/:id/start-failure",
    auth: "session",
    body: startFailure,
    status: 204,
  },
  "runner.trust": {
    method: "POST",
    path: "/runner/sessions/:id/trust",
    auth: "session",
    body: trustAnswer,
    status: 204,
  },
  "runner.workspaceRemoval": {
    method: "POST",
    path: "/runner/sessions/:id/workspace-removal",
    auth: "session",
    body: removalPost,
    status: 204,
  },
  "runner.events": {
    method: "POST",
    path: "/runner/sessions/:id/events",
    auth: "session",
    body: livePost,
    status: 204,
  },
  "runner.commands": {
    method: "GET",
    path: "/runner/sessions/:id/commands",
    auth: "session",
    query: generation,
    response: "stream",
  },
  "runner.tools": {
    method: "GET",
    path: "/runner/sessions/:id/tools",
    auth: "session",
    query: generation,
    response: Type.Array(toolSpec),
  },
  "runner.toolCalls.create": {
    method: "POST",
    path: "/runner/sessions/:id/tool-calls",
    auth: "session",
    body: toolCall,
    status: 202,
  },
  // The files of the Session's Profile, which the runner downloads when its
  // copy's hash differs (ADR 0041).
  "runner.profile": {
    method: "GET",
    path: "/runner/sessions/:id/profile",
    auth: "session",
    response: profileFiles,
  },
  // The docs every Session gets as files (ADR 0052).
  "runner.docs": {
    method: "GET",
    path: "/runner/sessions/:id/docs",
    auth: "session",
    response: profileFiles,
  },
  "runner.part": {
    method: "GET",
    path: "/runner/sessions/:id/parts/:plugin/:hash",
    auth: "session",
    response: "bytes",
  },
  // Plugin routes a Session part calls as its Session.
  "runner.ext": {
    method: "ANY",
    path: "/runner/sessions/:id/ext/:plugin/*path",
    auth: "session",
  },
} as const satisfies Readonly<Record<string, RouteSpec>>;

export type Routes = typeof routes;

export type RouteKey = keyof Routes;
