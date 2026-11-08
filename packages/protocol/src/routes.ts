import { type TObject, type TProperties, Type } from "typebox";
import {
  account,
  accountChange,
  accessToken,
  accessTokenRequest,
  appLink,
  appSignIn,
  configFile,
  configFiles,
  configFileWrite,
  createdAccessToken,
  createSession,
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
  type Profile,
  profileContent,
  profileEntry,
  repositoryManifest,
  restartRequest,
  sessionChange,
  serverSetup,
  serverSetupChange,
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
  at,
  environmentTools,
  named,
  pluginSummary,
  pluginTools,
  profileTools,
  profileSummary,
  profileView,
  sessionSummary,
  sessionTools,
  titleOf,
  withoutKey,
} from "./kernel-tools";
import {
  pluginFileContent,
  pluginConfig,
  pluginFileWrite,
  pluginInfo,
  type PluginInfo,
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
import { forkedSession, session, type Session } from "./session";
import { strings, textMap } from "./wire";

const any = Type.Unknown();
const generation = Type.Object({ generation: Type.Integer() });

const id = { id: Type.String() };

const toolParams = (properties: TProperties): TObject =>
  Type.Object(properties, { additionalProperties: false });

const profileFields = {
  description: Type.Optional(
    Type.String({ description: "What work the Profile is for, in a line" }),
  ),
  ...Type.Partial(
    Type.Pick(profileContent, [
      "packages",
      "agentsMd",
      "systemMd",
      "appendSystemMd",
      "settings",
    ]),
  ).properties,
};

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
    changes: ["people", "environments", "invites"],
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

  me: { method: "GET", path: "/api/me", auth: "person", response: account },
  "me.update": {
    method: "PATCH",
    path: "/api/me",
    auth: "person",
    body: accountChange,
    response: account,
    changes: ["people"],
  },
  // Signs the person out in every browser and app, and revokes their
  // access tokens.
  "me.signIns.remove": {
    method: "DELETE",
    path: "/api/me/sign-ins",
    auth: "person",
    status: 204,
    changes: ["access-tokens"],
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
    changes: ["setup"],
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
    changes: ["pinned-pages"],
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
  // Admins go through it once, before their own setup (ADR 0072).
  "settings.serverSetup": {
    method: "GET",
    path: "/api/settings/server-setup",
    auth: "admin",
    response: serverSetup,
  },
  "settings.serverSetup.update": {
    method: "PATCH",
    path: "/api/settings/server-setup",
    auth: "admin",
    body: serverSetupChange,
    response: serverSetup,
    changes: ["server-setup", "setup"],
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
    changes: ["config"],
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
    changes: ["invites"],
  },
  "invites.remove": {
    method: "DELETE",
    path: "/api/invites/:id",
    auth: "admin",
    status: 204,
    changes: ["invites"],
  },

  "plugins.list": {
    method: "GET",
    path: "/api/plugins",
    auth: "person",
    response: Type.Array(pluginInfo),
    tool: {
      name: "plugins_list",
      namespace: pluginTools,
      description:
        "List the plugins with their state, whether they are turned on, and where installed ones came from.",
      annotations: { readOnlyHint: true },
      result: (body) => (body as readonly PluginInfo[]).map(pluginSummary),
    },
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
    tool: {
      name: "plugins_files",
      namespace: pluginTools,
      description: "List the files of an installed plugin.",
      annotations: { readOnlyHint: true },
    },
  },
  "plugins.file": {
    method: "GET",
    path: "/api/plugins/:plugin/files/*path",
    auth: "person",
    response: Type.Object({ path: Type.String(), content: Type.String() }),
    tool: {
      name: "plugins_read_file",
      namespace: pluginTools,
      description: "Read a file of an installed plugin.",
      annotations: { readOnlyHint: true },
    },
  },
  "plugins.file.write": {
    method: "PUT",
    path: "/api/plugins/:plugin/files/*path",
    auth: "person",
    body: pluginFileContent,
    response: pluginInfo,
    changes: ["plugins"],
    tool: {
      name: "plugins_write_file",
      namespace: pluginTools,
      internal: true,
      description:
        "Write a file of an in-place plugin, making the plugin when it doesn't exist yet. Nothing in it runs until the user turns it on.",
      params: toolParams({
        plugin: Type.String({ description: "The plugin's id" }),
        ...pluginFileWrite.properties,
      }),
      annotations: { destructiveHint: false, openWorldHint: false },
      result: (body) => pluginSummary(body as PluginInfo),
    },
  },
  "plugins.builds.create": {
    method: "POST",
    path: "/api/plugins/:plugin/builds",
    auth: "person",
    response: pluginInfo,
    status: 201,
    changes: ["plugins"],
    long: true,
    tool: {
      name: "plugins_build",
      namespace: pluginTools,
      internal: true,
      description:
        "Install an in-place plugin's dependencies and bundle its parts, to see whether it builds. None of its code runs.",
      annotations: { destructiveHint: false, openWorldHint: true },
      result: (body) => ({
        ...pluginSummary(body as PluginInfo),
        note: "It builds. The user turns it on on the Plugins page, then restarts the server.",
      }),
      opens: () => ({ route: "plugins", label: "the Plugins page" }),
    },
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

  "environments.list": {
    method: "GET",
    path: "/api/environments",
    auth: "person",
    query: Type.Object({ scope }),
    response: Type.Array(environment),
    tool: {
      name: "environments_list",
      namespace: environmentTools,
      description:
        "List Environments with their runners, isolation, image, setup script, variables and secret names.",
      params: toolParams({}),
      annotations: { readOnlyHint: true },
    },
  },
  "environments.create": {
    method: "POST",
    path: "/api/environments",
    auth: "person",
    body: createEnvironment,
    response: createdEnvironment,
    status: 201,
    changes: ["environments"],
    tool: {
      name: "environments_create",
      namespace: environmentTools,
      description: "Create an Environment with a name.",
      params: toolParams({ name: createEnvironment.properties.name }),
      annotations: { destructiveHint: false, openWorldHint: false },
      result: (body) => ({
        environment: withoutKey(body),
        note: "Its runner key isn't shown here. The user gets one with Replace key on the Environments page.",
      }),
    },
  },
  "environments.update": {
    method: "PATCH",
    path: "/api/environments/:id",
    auth: "person",
    body: environmentUpdate,
    response: environment,
    changes: ["environments"],
    tool: {
      name: "environments_update",
      namespace: environmentTools,
      description:
        "Change an Environment. Only the fields given change; variables replaces all of its variables.",
      params: toolParams({
        ...id,
        ...Type.Pick(environmentUpdate, [
          "name",
          "isolation",
          "image",
          "setupScript",
          "variables",
        ]).properties,
      }),
      annotations: { destructiveHint: true },
      asks: {
        lookup: () => "/api/environments",
        text: (input, found) =>
          `Change ${named(found, input, "the Environment", "this Environment")}?`,
      },
    },
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
    changes: ["templates"],
    long: true,
  },
  "environmentTemplates.update": {
    method: "PATCH",
    path: "/api/environment-templates/:id",
    auth: "admin",
    body: any,
    response: listedTemplate,
    changes: ["templates", "environments"],
  },
  "environmentTemplates.remove": {
    method: "DELETE",
    path: "/api/environment-templates/:id",
    auth: "admin",
    status: 204,
    changes: ["templates", "environments"],
  },
  // Reads its repository again now, rather than at the next sync.
  "environmentTemplates.syncs.create": {
    method: "POST",
    path: "/api/environment-templates/:id/syncs",
    auth: "admin",
    response: listedTemplate,
    status: 201,
    changes: ["templates", "environments"],
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
    tool: {
      name: "profiles_list",
      namespace: profileTools,
      description:
        "List the user's Profiles with what each is for. Read one in full with profiles_get.",
      params: toolParams({}),
      annotations: { readOnlyHint: true },
      result: (body) => (body as readonly Profile[]).map(profileSummary),
    },
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
    tool: {
      name: "profiles_create",
      namespace: profileTools,
      description: "Create a Profile.",
      params: toolParams({ name: Type.String(), ...profileFields }),
      // Its packages are installed and run in every Session that uses it.
      annotations: { destructiveHint: false, openWorldHint: true },
      result: (body) => profileView(body as Profile),
    },
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
    tool: {
      name: "profiles_get",
      namespace: profileTools,
      description: "Get one Profile by id.",
      annotations: { readOnlyHint: true },
      result: (body) => profileView(body as Profile),
    },
  },
  // Its content, and isDefault: true to make it the default.
  "profiles.update": {
    method: "PATCH",
    path: "/api/profiles/:id",
    auth: "person",
    body: any,
    response: profile,
    changes: ["profiles"],
    tool: [
      {
        name: "profiles_update",
        namespace: profileTools,
        description:
          "Change a Profile. Only the fields given change. Sessions pick it up the next time their Pi starts.",
        params: toolParams({
          ...id,
          name: Type.Optional(Type.String()),
          ...profileFields,
        }),
        annotations: { destructiveHint: true },
        asks: {
          lookup: (input) => at("/api/profiles/:id", input),
          text: (input, found) =>
            `Change ${named(found, input, "the Profile", "this Profile")}?`,
        },
        result: (body) => profileView(body as Profile),
      },
      {
        name: "profiles_make_default",
        namespace: profileTools,
        description: "Make a Profile the one new Sessions use by default.",
        params: toolParams(id),
        body: { isDefault: true },
        annotations: { destructiveHint: true },
        asks: {
          lookup: (input) => at("/api/profiles/:id", input),
          text: (input, found) =>
            `Make ${named(found, input, "the Profile", "this Profile")} the default for new Sessions?`,
        },
      },
    ],
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
  // The folder a runner gets for a Session of the caller's on this Profile,
  // with every layer under it, as text by path (ADR 0074).
  "profiles.stacked": {
    method: "GET",
    path: "/api/profiles/:id/stacked",
    auth: "person",
    response: textMap,
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
    tool: {
      name: "profiles_upload",
      namespace: profileTools,
      description:
        "Write files into a Profile's folder, as { path: base64 content }.",
      internal: true,
      annotations: { destructiveHint: true },
    },
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
    tool: {
      name: "sessions_list",
      namespace: sessionTools,
      description:
        "List the user's Sessions, newest first, with their status. Archived ones only when archived is true.",
      params: toolParams({ archived: Type.Optional(Type.Boolean()) }),
      exposure: "direct",
      annotations: { readOnlyHint: true },
      result: (body) => (body as readonly Session[]).map(sessionSummary),
    },
  },
  "sessions.create": {
    method: "POST",
    path: "/api/sessions",
    auth: "person",
    body: newSession,
    response: forkedSession,
    status: 201,
    tool: {
      name: "sessions_start",
      namespace: sessionTools,
      description:
        "Start a Session. Without an environment or profile it uses the defaults. firstMessage is what the Session's agent is asked to do first.",
      params: toolParams(
        Type.Pick(createSession, [
          "environment",
          "profile",
          "workspace",
          "model",
          "firstMessage",
        ]).properties,
      ),
      exposure: "direct",
      // The new Session's agent runs whatever firstMessage says without a
      // confirm of its own, so starting one is open-world.
      annotations: { destructiveHint: false, openWorldHint: true },
      result: (body) => sessionSummary(body as Session),
      opens: (body) => ({
        route: (body as Session).id,
        label: "the new Session",
      }),
    },
  },
  "sessions.get": {
    method: "GET",
    path: "/api/sessions/:id",
    auth: "person",
    response: session,
    tool: [
      {
        name: "sessions_get",
        namespace: sessionTools,
        description: "Get one Session by id.",
        annotations: { readOnlyHint: true },
      },
      {
        name: "sessions_open",
        namespace: sessionTools,
        description: "Open a Session for the user to watch or take over.",
        exposure: "direct",
        annotations: { readOnlyHint: true },
        result: () =>
          "Offered it to the user in the browsers that show this chat.",
        opens: (body) => ({
          route: (body as Session).id,
          label: titleOf(body as Session),
        }),
      },
    ],
  },
  "sessions.update": {
    method: "PATCH",
    path: "/api/sessions/:id",
    auth: "person",
    body: sessionChange,
    response: session,
    tool: {
      name: "sessions_archive",
      namespace: sessionTools,
      description:
        "Archive a Session. Its workspace is removed when nothing would lose work.",
      params: toolParams(id),
      body: { archived: true },
      annotations: { destructiveHint: true },
      asks: {
        lookup: (input) => at("/api/sessions/:id", input),
        text: (_input, found) =>
          `Archive ${found === undefined ? "this Session" : titleOf(found as Session)}?`,
      },
    },
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
  // ack: the last sequence the host took, when it opens the stream again.
  "runner.commands": {
    method: "GET",
    path: "/runner/sessions/:id/commands",
    auth: "session",
    query: Type.Object({
      generation: Type.Integer(),
      ack: Type.Optional(Type.Integer()),
    }),
    response: "stream",
  },
  // The host took every command up to this sequence, so the server forgets
  // them.
  "runner.acks.create": {
    method: "POST",
    path: "/runner/sessions/:id/acks",
    auth: "session",
    body: Type.Object({ generation: Type.Integer(), seq: Type.Integer() }),
    status: 204,
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
  // What to ask the person before a call of a tool that asks.
  "runner.toolQuestions.create": {
    method: "POST",
    path: "/runner/sessions/:id/tool-questions",
    auth: "session",
    body: Type.Omit(toolCall, ["id"]),
    response: Type.Object({
      question: Type.Union([Type.String(), Type.Null()]),
    }),
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
} as const satisfies Readonly<Record<string, RouteSpec>>;

export type Routes = typeof routes;

export type RouteKey = keyof Routes;
