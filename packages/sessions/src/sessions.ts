import type { KernelEvent, ModelOffer, StartRequest } from "@pipoca/plugins";
import {
  type Actor,
  type Assignment,
  type Attempt,
  type Command,
  type ForkedSession,
  type GitLogin,
  type LiveEvent,
  movable,
  type LivePost,
  liveSurface,
  type ModelRef,
  type ProfileContent,
  type ProfileFiles,
  type Removal,
  type RemovalPost,
  type Session,
  type SessionAccess,
  type SessionEvent,
  type SessionOwner,
  type SessionStatus,
  type StartFailure,
  type TranscriptAck,
  type TranscriptBatch,
  trustedRepository,
  type TrustAnswer,
  teamMessagesRead,
  teamTalkSince,
  type Quote,
  type Voice,
  type Work,
  type Workspace,
  type WorkspaceRequest,
} from "@pipoca/protocol";
import {
  contentFiles,
  overBaseExtensions,
  defaultProfileId as sharedProfileId,
} from "@pipoca/profiles";
import type { SessionEnvironment, WorkPoll } from "@pipoca/protocol";
import { canSee, canSteer, type Owned } from "@pipoca/people";
import { type Clock, type Log, systemClock } from "@pipoca/protocol";
import {
  type Delivery,
  type Outgoing,
  Outbox,
  type OutboxStore,
  type Queued,
} from "./outbox";

export type StoredSession = Omit<
  Session,
  "online" | "waiting" | "ownedBy" | "access"
>;

// Where Sessions run, which the server's Environments are (ADR 0032).
export interface SessionEnvironments {
  readonly all: () => readonly {
    readonly id: string;
    readonly provider: string;
    readonly ownerId: string;
    readonly templateId: string | null;
  }[];
  readonly sessionEnvironment: (id: string) => SessionEnvironment;
  readonly beginPoll: (
    runner: { readonly name: string; readonly environment: string },
    poll: {
      readonly capacity: number | null;
      readonly inventory: Pick<WorkPoll, "folders" | "models" | "session">;
      readonly registeredModels?: readonly ModelRef[] | undefined;
    },
  ) => () => void;
  readonly waitForWork: (
    provider: string,
    runner: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly wake: (provider: string) => void;
  readonly runners: (provider: string) => readonly {
    readonly name: string;
    readonly online: boolean;
    readonly capacity: number | null;
    readonly inventory: { readonly session?: string | undefined };
  }[];
  readonly online: (provider: string, runner: string) => boolean;
  readonly leaseLapsed: (provider: string, runner: string) => boolean;
  readonly mayTake: (
    provider: string,
    session: StoredSession,
    runner: string,
  ) => boolean;
  readonly placesOnNewRunner: (
    provider: string,
    session: StoredSession,
  ) => boolean;
}

// The owner of what the team owns, rather than one person (ADR 0064).
const teamOwner = "team";

// What a team Session keeps of who said what, by actor rather than by name.
export type StoredVoice = Omit<Voice, "person"> & {
  readonly actor: Actor;
  readonly requestId?: string;
};

export interface BindingStore {
  readonly bind: (
    plugin: string,
    key: string,
    sessionId: string,
    at: number,
  ) => void;
  readonly boundTo: (plugin: string, key: string) => string | undefined;
  readonly unbind: (plugin: string, key: string) => void;
}

export interface SessionStore {
  profile: (id: string) =>
    | (ProfileContent & {
        readonly id: string;
        readonly ownerId: string | null;
      })
    | undefined;
  // Throws ProfileTooBig for a Profile runners shouldn't download.
  // For a Session the person started, over the layers below (ADR 0063).
  profileFiles: (
    id: string,
    personId: string | null,
  ) => ProfileFiles | undefined;
  // The admin's base Profile (ADR 0044) and the person's My defaults, if
  // there are any.
  baseProfileFiles: (personId: string | null) => ProfileFiles | undefined;
  defaultProfileId: (userId: string) => string;
  // Where the person's Sessions start when they don't pick, if they chose.
  defaultEnvironmentId: (userId: string) => string | null;
  repositoryTrust: (ownerId: string, repository: string) => boolean | null;
  setRepositoryTrust: (
    ownerId: string,
    repository: string,
    trusted: boolean,
  ) => void;
  insert: (session: StoredSession) => void;
  update: (session: StoredSession) => void;
  get: (id: string) => StoredSession | undefined;
  list: (options: {
    readonly includeArchived: boolean;
    readonly owner?: SessionOwner;
  }) => readonly StoredSession[];
  // Undefined while the Session is open to the whole team.
  access: (id: string) => SessionAccess | undefined;
  setAccess: (id: string, access: SessionAccess) => void;
  voices: (id: string) => readonly StoredVoice[];
  // False when the Session already keeps one with the voice's requestId.
  addVoice: (id: string, voice: StoredVoice) => boolean;
  readonly outbox: OutboxStore;
  readonly bindings: BindingStore;
  byEnvironment: (
    provider: string,
    statuses: readonly SessionStatus[],
  ) => readonly StoredSession[];
  byRunner: (
    provider: string,
    runner: string,
    statuses: readonly SessionStatus[],
  ) => readonly StoredSession[];
  // Removals for the runner's workspaces, and for Sessions in its
  // Environment that never reached a runner.
  pendingRemovals: (
    provider: string,
    runner: string,
  ) => readonly StoredSession[];
  transcriptLength: (id: string) => number;
  appendTranscript: (
    id: string,
    start: number,
    lines: readonly string[],
  ) => void;
  transcript: (id: string, from: number) => readonly string[];
  setTitle: (id: string, title: string) => void;
  setModel: (id: string, model: ModelRef) => void;
}

export type Rejection =
  | "not_found"
  | "stale_generation"
  | "offline"
  | "archived"
  | "not_kept"
  | "unknown_environment"
  | "unknown_profile"
  | "not_movable"
  | "unknown_entry"
  | "not_team"
  | "not_starter"
  | "not_personal"
  | "view_only";

export type Result<T, R extends Rejection = Rejection> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: R };

export type SessionPlugins = Required<
  Pick<Assignment, "plugins" | "pluginSettings">
> &
  Pick<Assignment, "pluginConfig"> & {
    // Session plugins that load only in the Sessions their plugin owns.
    readonly ownSessionsOnly?: readonly string[];
    // The Session plugins that load in a plugin's own Sessions, for plugins
    // that limit them.
    readonly loadOnly?: Readonly<Record<string, readonly string[]>>;
    // The installed plugins' Session parts, by name, with their bundles' hash.
    readonly installedParts?: Readonly<Record<string, string>>;
    // The Session plugins that load in team work (ADR 0067).
    readonly teamWork?: readonly string[];
  };

export interface SessionsOptions {
  readonly clock?: Clock;
  readonly events?: (event: KernelEvent) => void;
  // Called whenever a Session starts or its view changes (ADR 0038).
  readonly changed?: () => void;
  // The plugins whose Session parts a Session gets when it starts, and their
  // settings.
  readonly sessionPlugins?: () => SessionPlugins;
  readonly offeredModels?: ModelOffer;
  // A Profile a plugin provides, which only the plugin's own Sessions run on.
  readonly pluginProfile?: (id: string) => PluginProfile | undefined;
  // The git hosts a user connected (ADR 0043).
  readonly gitLogins?: (
    userId: string,
    session: Pick<Session, "actsAs" | "workspace">,
  ) => readonly GitLogin[];
  // How many of the team's messages since its last turn Pi reads.
  readonly teamMessagesRead?: () => number;
  // The docs every Session gets as files (ADR 0052).
  readonly docs?: ProfileFiles;
  // A user's name, which Pi reads team messages with (ADR 0065).
  readonly names?: (person: string) => string | undefined;
  readonly log?: Log;
}

export interface PluginProfile {
  readonly plugin: string;
  readonly profile: ProfileContent & { readonly id: string };
  // Other plugins whose own Sessions may run on it.
  readonly sharedWith?: readonly string[];
  // Team work may run on it too, such as each person's Team assistant
  // (ADR 0067).
  readonly team?: boolean;
}

// The server adds the Profiles, which Sessions don't hold.
export interface Claim extends Omit<Work, "profiles" | "start"> {
  readonly start: readonly Assignment[];
  readonly interrupted: readonly Attempt[];
}

type Listener<T> = (value: T) => void;

// False when the host's stream ended before it took the command.
type HostSend = (command: Command) => boolean;

// Enough to catch a browser retrying a send; ids only need to outlive retries.
const maxRequestIds = 100;
const claimableStatuses: readonly SessionStatus[] = ["queued", "interrupted"];
const attempting: readonly SessionStatus[] = ["starting", "idle", "running"];

// A message to a Session whose runner hasn't connected yet waits for it, as
// the first message does.
const unhosted: readonly SessionStatus[] = ["queued", "starting"];

export class Sessions {
  readonly #store: SessionStore;
  readonly #clock: Clock;
  readonly #environments: SessionEnvironments;
  readonly #events: (event: KernelEvent) => void;
  readonly #changed: () => void;
  readonly #sessionPlugins: () => SessionPlugins;
  readonly #offeredModels: ModelOffer;
  readonly #pluginProfile: (id: string) => PluginProfile | undefined;
  readonly #gitLogins: NonNullable<SessionsOptions["gitLogins"]>;
  readonly #teamMessagesRead: () => number;
  readonly #names: (person: string) => string | undefined;
  readonly #docs: ProfileFiles | undefined;
  readonly #watchers = new Map<string, Set<Listener<SessionEvent>>>();
  readonly #hosts = new Map<
    string,
    { readonly send: HostSend; readonly end: () => void }
  >();
  readonly #requestIds = new Map<string, Set<string>>();
  readonly #held = new Map<string, Command[]>();
  readonly #outbox: Outbox;
  readonly #hostedGeneration = new Map<string, number>();
  readonly #surfaces = new Map<
    string,
    { readonly generation: number; readonly events: Map<string, LiveEvent> }
  >();

  constructor(
    store: SessionStore,
    environments: SessionEnvironments,
    options: SessionsOptions = {},
  ) {
    this.#store = store;
    this.#environments = environments;
    this.#clock = options.clock ?? systemClock;
    this.#events = options.events ?? (() => undefined);
    this.#changed = options.changed ?? (() => undefined);

    this.#sessionPlugins =
      options.sessionPlugins ?? (() => ({ plugins: [], pluginSettings: {} }));

    this.#docs = options.docs;

    this.#offeredModels = options.offeredModels ?? (() => ({ models: [] }));
    this.#pluginProfile = options.pluginProfile ?? (() => undefined);
    this.#gitLogins = options.gitLogins ?? (() => []);

    this.#teamMessagesRead =
      options.teamMessagesRead ?? (() => teamMessagesRead);

    this.#names = options.names ?? (() => undefined);

    this.#outbox = new Outbox(
      store.outbox,
      (message) => this.#deliver(message),
      this.#clock,
      options.log ?? (() => undefined),
    );
  }

  // The one way a Session starts, for the UI and plugins alike (ADR 0015).
  start(request: StartRequest, ownedBy?: SessionOwner): Result<Session> {
    // The Profiles a Session may use are its starter's (ADR 0041), and so
    // are the Environments (ADR 0049).
    const startedBy = this.#starter(request.actor);

    // A Session that team work starts is team work too, so nothing a team
    // Session runs reaches its starter's own runners or logins.
    const team = request.team === true || this.#fromTeam(request.actor);

    const environments = this.#environments
      .all()
      .filter(({ ownerId }) =>
        team
          ? ownerId === teamOwner
          : ownerId !== teamOwner &&
            (startedBy === null || ownerId === startedBy),
      );

    const picked =
      request.environment ??
      (team || startedBy === null
        ? undefined
        : (this.#store.defaultEnvironmentId(startedBy) ?? undefined));

    const environment =
      picked === undefined
        ? environments[0]
        : environments.find(({ id }) => id === picked);

    if (!environment) {
      return { ok: false, reason: "unknown_environment" };
    }

    const ownDefault =
      startedBy === null
        ? sharedProfileId
        : this.#store.defaultProfileId(startedBy);

    const profileId = request.profile ?? (team ? "" : ownDefault);

    const provided = this.#pluginProfile(profileId);

    const stored = this.#store.profile(profileId);

    // Shared Profiles have no owner (ADR 0041). Team work runs only on the
    // team's (ADR 0064).
    const usable =
      provided === undefined
        ? stored !== undefined &&
          (team
            ? stored.ownerId === teamOwner
            : stored.ownerId === null || stored.ownerId === startedBy)
        : (!team || provided.team === true) &&
          ownedBy !== undefined &&
          (provided.plugin === ownedBy.plugin ||
            provided.sharedWith?.includes(ownedBy.plugin) === true);

    if (!usable) {
      return { ok: false, reason: "unknown_profile" };
    }

    const id = Bun.randomUUIDv7();

    const session: StoredSession = {
      id,
      environmentId: environment.id,
      owner: ownedBy ?? null,
      provider: environment.provider,
      runner: null,
      profileId,
      workspace:
        request.workspace.kind === "folder"
          ? request.workspace
          : { ...request.workspace, branch: `pipoca/${id.slice(-8)}` },
      model: request.model ?? this.#offeredModels(environment).default ?? null,
      thinking: request.thinking ?? null,
      systemPrompt: request.systemPrompt ?? null,
      firstMessage: request.firstMessage ?? null,
      title: null,
      status: "queued",
      generation: 0,
      createdAt: new Date(this.#clock.now()).toISOString(),
      interruptedAt: null,
      error: null,
      archivedAt: null,
      workspaceRemoval: null,
      workspaceKeptReason: null,
      startedBy,
      actsAs: request.actsAs ?? null,
    };

    this.#store.insert(session);

    if (team && request.access !== undefined) {
      this.#store.setAccess(id, request.access);
    }

    this.#environments.wake(session.provider);
    const view = this.#view(session);
    this.#changed();

    this.#events({
      type: "SessionCreated",
      session: view,
      actor: request.actor,
    });

    return { ok: true, value: view };
  }

  // A fork is a new Session that starts from another's transcript, on its
  // own branch from the one that Session works on, in any Environment
  // (ADR 0034). Only what the Session pushed reaches another machine, so a
  // Session in a folder of its machine forks only within its Environment.
  // A fork belongs to no plugin, so a plugin's prompt stays behind.
  // From a user message it is Pi's /fork: the transcript up to that message,
  // whose text comes back for the new Session's composer. Without one it is
  // Pi's /clone.
  // Team work forks as team work, or to the person's own side with personal,
  // where it runs on their own Profile and logins (ADR 0067).
  fork(
    id: string,
    request: {
      readonly environment?: string;
      readonly entry?: string;
      readonly personal?: boolean;
      readonly actor: Actor;
    },
  ): Result<ForkedSession> {
    const source = this.#store.get(id);
    if (!source) {
      return { ok: false, reason: "not_found" };
    }

    const transcript = this.#store.transcript(id, 0);

    const before =
      request.entry === undefined
        ? undefined
        : branchBefore(transcript, request.entry);

    if (request.entry !== undefined && before === undefined) {
      return { ok: false, reason: "unknown_entry" };
    }

    const fromTeam = this.#team(source);
    const team = fromTeam && request.personal !== true;
    const sameSide = team === fromTeam;

    const environment =
      request.environment ?? (sameSide ? source.environmentId : undefined);

    if (environment !== source.environmentId && !movable(source.workspace)) {
      return { ok: false, reason: "not_movable" };
    }

    // A fork belongs to no plugin, so it can't keep a plugin's Profile.
    const forked = this.start({
      ...(environment !== undefined && { environment }),
      ...(team && { team }),
      ...(sameSide &&
        this.#pluginProfile(source.profileId) === undefined && {
          profile: source.profileId,
        }),
      workspace: forkedWorkspace(source),
      ...(sameSide && source.model && { model: source.model }),
      ...(source.thinking && { thinking: source.thinking }),
      ...(source.owner === null &&
        source.systemPrompt !== null && { systemPrompt: source.systemPrompt }),
      actor: request.actor,
    });

    if (!forked.ok) {
      return forked;
    }

    this.#store.appendTranscript(
      forked.value.id,
      0,
      before?.lines ?? transcript,
    );

    if (source.title !== null) {
      this.#store.setTitle(
        forked.value.id,
        `${Array.from(source.title).slice(0, titleLength).join("")} (fork)`,
      );
    }

    return {
      ok: true,
      value: {
        ...(this.get(forked.value.id) ?? forked.value),
        ...(before && { editorText: before.text }),
      },
    };
  }

  // Personal work moves to the team as a new team Session that starts from a
  // handoff summary the person edited, never the transcript, with a fresh
  // Workspace from the same repositories (ADR 0067).
  move(
    id: string,
    request: {
      readonly summary: string;
      readonly environment?: string;
      readonly profile?: string;
      readonly actor: Actor;
    },
  ): Result<Session> {
    const source = this.#store.get(id);
    const person = personOf(request.actor);

    if (
      source === undefined ||
      person === undefined ||
      !canSteer({ id: person, admin: false }, this.#owned(source))
    ) {
      return { ok: false, reason: "not_found" };
    }

    if (this.#team(source)) {
      return { ok: false, reason: "not_personal" };
    }

    const workspace = freshWorkspace(source.workspace);

    if (workspace === undefined) {
      return { ok: false, reason: "not_movable" };
    }

    const moved = this.start({
      team: true,
      ...(request.environment !== undefined && {
        environment: request.environment,
      }),
      ...(request.profile !== undefined && { profile: request.profile }),
      workspace,
      ...(source.thinking && { thinking: source.thinking }),
      firstMessage: request.summary,
      actor: request.actor,
    });

    if (!moved.ok) {
      return moved;
    }

    if (source.title !== null) {
      this.#store.setTitle(moved.value.id, source.title);
    }

    const view = this.get(moved.value.id) ?? moved.value;

    this.#events({
      type: "SessionMoved",
      session: view,
      from: source.id,
      actor: request.actor,
    });

    return { ok: true, value: view };
  }

  // With team, only the team's Sessions the person may see, or all of them
  // without a person.
  list({
    archived = false,
    owner: ownedBy,
    person,
    team = false,
  }: {
    readonly archived?: boolean;
    readonly owner?: SessionOwner;
    readonly person?: string;
    readonly team?: boolean;
  } = {}): readonly Session[] {
    return this.#store
      .list({ includeArchived: archived, ...(ownedBy && { owner: ownedBy }) })
      .filter((session) =>
        team
          ? this.#team(session) &&
            (person === undefined ||
              canSee({ id: person, admin: false }, this.#owned(session)))
          : person === undefined ||
            (!this.#team(session) && this.#person(session) === person),
      )
      .map((session) => this.#view(session));
  }

  // Who may open and steer the Session: its person (ADR 0049), or the
  // team, unless its starter limited it (ADR 0064).
  owned(id: string): Owned | undefined {
    const session = this.#store.get(id);

    return session && this.#owned(session);
  }

  // Whoever started team work, or an admin, makes it view-only for everyone
  // else, limits it to named people, or opens it to the team again.
  limit(
    id: string,
    access: SessionAccess,
    by: { readonly person: string; readonly admin: boolean },
  ): Result<Session> {
    const session = this.#store.get(id);

    if (
      session === undefined ||
      (!by.admin &&
        !canSee({ id: by.person, admin: false }, this.#owned(session)))
    ) {
      return { ok: false, reason: "not_found" };
    }

    if (!by.admin && session.startedBy !== by.person) {
      return { ok: false, reason: "not_starter" };
    }

    if (!this.#team(session)) {
      return { ok: false, reason: "not_team" };
    }

    this.#store.setAccess(session.id, access);
    const view = this.#view(session);
    this.#emit(session.id, { type: "session", session: view });

    this.#events({
      type: "AccessChanged",
      session: view,
      actor: `user:${by.person}`,
    });

    return { ok: true, value: view };
  }

  // People in a team Session talk to each other as well as to Pi
  // (ADR 0065). Pi reads what they say to the team the next time it's asked,
  // and never what they say off the record.
  say(
    id: string,
    {
      actor,
      text,
      to,
      quote,
      requestId,
    }: {
      readonly actor: Actor;
      readonly text: string;
      readonly to: "team" | "aside";
      readonly quote?: Quote;
      readonly requestId?: string;
    },
  ): Result<undefined, "not_found" | "archived" | "not_team"> {
    const session = this.#store.get(id);
    const person = personOf(actor);

    if (session === undefined || person === undefined) {
      return { ok: false, reason: "not_found" };
    }

    if (session.archivedAt !== null) {
      return { ok: false, reason: "archived" };
    }

    if (!this.#team(session)) {
      return { ok: false, reason: "not_team" };
    }

    this.#addVoice(session.id, {
      kind: to,
      actor,
      at: new Date(this.#clock.now()).toISOString(),
      text,
      ...(quote && { quote }),
      ...(requestId !== undefined && { requestId }),
    });

    return { ok: true, value: undefined };
  }

  // Several people steer a team Session, so it keeps who said what. False
  // for a message it already kept.
  #voice(session: StoredSession, command: Command, quote?: Quote): boolean {
    if (
      personOf(command.actor) === undefined ||
      !this.#team(session) ||
      (command.type !== "message" && command.type !== "abort")
    ) {
      return true;
    }

    return this.#addVoice(session.id, {
      kind: command.type === "abort" ? "stop" : "message",
      actor: command.actor,
      at: new Date(this.#clock.now()).toISOString(),
      ...(command.type === "message" && { text: command.text }),
      ...(command.type === "message" && quote && { quote }),
      ...(command.type === "message" &&
        command.requestId !== undefined && { requestId: command.requestId }),
    });
  }

  // Anyone who steers team work may answer Pi's questions, so Pi hears who
  // did (ADR 0065).
  #answeredBy(session: StoredSession, command: Command): Command {
    const person = personOf(command.actor);
    const name = person === undefined ? undefined : this.#names(person);

    if (
      command.type !== "answer" ||
      name === undefined ||
      !this.#team(session) ||
      typeof command.value !== "object" ||
      command.value === null
    ) {
      return command;
    }

    return { ...command, value: { ...command.value, by: name } };
  }

  #addVoice(id: string, stored: StoredVoice): boolean {
    if (!this.#store.addVoice(id, stored)) {
      return false;
    }

    this.#emit(id, { type: "voice", voice: voiceOf(stored) });

    return true;
  }

  #voices(id: string): readonly Voice[] {
    return this.#store.voices(id).map(voiceOf);
  }

  // What Pi reads before a person's message in a team Session: who sends
  // it, what it replies to, and what the team said since Pi's last turn.
  #teamContext(
    session: StoredSession,
    command: Command,
    quote: Quote | undefined,
  ): readonly Command[] {
    const person = personOf(command.actor);

    if (
      command.type !== "message" ||
      person === undefined ||
      !this.#team(session)
    ) {
      return [];
    }

    const said = teamTalkSince(this.#voices(session.id));

    const read = this.#teamMessagesRead();
    const left = said.length - read;

    const lines = [
      ...(said.length === 0 ? [] : ["The team talked since your last turn:"]),
      ...(left > 0
        ? [
            `(${String(left)} earlier messages are left out. Suggest forking the Session if they matter.)`,
          ]
        : []),
      ...said.slice(-read).map((voice) => {
        const text = clipped(voice.text ?? "", teamMessageLength);

        return voice.kind === "notice"
          ? text
          : `${this.#said(voice.person, voice.quote)}: ${text}`;
      }),
      ...(said.length === 0 ? [] : [""]),
      `${this.#said(person, quote)} sends the next message.`,
    ];

    return [
      {
        type: "context",
        text: lines.join("\n"),
        hidden: true,
        actor: command.actor,
      },
    ];
  }

  #said(person: string, quote: Quote | undefined): string {
    const name = this.#names(person) ?? "Someone";

    return quote === undefined
      ? name
      : `${name}, replying to ${quote.from === "pi" ? "you" : (this.#names(quote.from) ?? "someone")} ("${clipped(quote.text, quoteLength)}")`;
  }

  #owned(session: StoredSession): Owned {
    return this.#team(session)
      ? {
          owner: teamOwner,
          startedBy: session.startedBy,
          access: this.#store.access(session.id) ?? { kind: "team" },
        }
      : { owner: this.#person(session) ?? "" };
  }

  #team(session: Pick<StoredSession, "environmentId">): boolean {
    return this.#ownerOf(session.environmentId) === teamOwner;
  }

  #ownerOf(environmentId: string): string | undefined {
    return this.#environments.all().find(({ id }) => id === environmentId)
      ?.ownerId;
  }

  // A Session that a team Session starts, directly or further down.
  #fromTeam(actor: Actor): boolean {
    const [kind = "", id = ""] = actor.split(/:(.*)/);
    const session = kind === "session" ? this.#store.get(id) : undefined;

    return session !== undefined && this.#team(session);
  }

  // Who started a Session, or else whose Environment it runs in.
  #person(session: StoredSession): string | null {
    return session.startedBy ?? this.#ownerOf(session.environmentId) ?? null;
  }

  archive(id: string, actor?: Actor): Result<Session> {
    const session = this.#store.get(id);
    if (!session) {
      return { ok: false, reason: "not_found" };
    }

    if (session.archivedAt !== null) {
      return { ok: true, value: this.#view(session) };
    }

    const archived: StoredSession = {
      ...session,
      status: "stopped",
      archivedAt: new Date(this.#clock.now()).toISOString(),
      workspaceRemoval: session.workspace.kind === "folder" ? null : "pending",
      workspaceKeptReason: null,
    };

    this.#hosts.get(id)?.end();
    this.#requestIds.delete(id);
    this.#outbox.drop(id, "archived");
    this.#update(archived);
    this.#environments.wake(session.provider);

    this.#events({
      type: "SessionArchived",
      session: this.#view(archived),
      ...(actor !== undefined && { actor }),
    });

    return { ok: true, value: this.#view(archived) };
  }

  unarchive(id: string, actor?: Actor): Result<Session> {
    const session = this.#store.get(id);
    if (!session) {
      return { ok: false, reason: "not_found" };
    }

    if (session.archivedAt === null) {
      return { ok: true, value: this.#view(session) };
    }

    // A Session's Profile is fixed, so once it is deleted the Session can't
    // run again (ADR 0031).
    if (!this.#profile(session.profileId)) {
      return { ok: false, reason: "unknown_profile" };
    }

    const unarchived: StoredSession = {
      ...session,
      status: "queued",
      archivedAt: null,
      workspaceRemoval: null,
      workspaceKeptReason: null,
    };

    this.#update(unarchived);
    this.#environments.wake(session.provider);

    this.#events({
      type: "SessionUnarchived",
      session: this.#view(unarchived),
      archivedAt: session.archivedAt,
      ...(actor !== undefined && { actor }),
    });

    return { ok: true, value: this.#view(unarchived) };
  }

  forceRemoval(id: string): Result<Session> {
    const session = this.#store.get(id);
    if (!session) {
      return { ok: false, reason: "not_found" };
    }

    if (session.workspaceRemoval !== "kept") {
      return { ok: false, reason: "not_kept" };
    }

    const forced: StoredSession = {
      ...session,
      workspaceRemoval: "forced",
      workspaceKeptReason: null,
    };

    this.#update(forced);
    this.#environments.wake(session.provider);

    return { ok: true, value: this.#view(forced) };
  }

  reportRemoval(id: string, report: RemovalPost): Result<undefined> {
    const session = this.#store.get(id);
    if (!session) {
      return { ok: false, reason: "not_found" };
    }

    // An unarchive can land while the removal runs, and a new archive after
    // it. The workspace is gone either way and comes back from restore, but
    // only a report from this archive's generation settles the removal.
    const settles =
      session.archivedAt !== null && report.generation === session.generation;

    this.#update({
      ...session,
      workspace: report.restore ?? session.workspace,
      ...(settles && {
        workspaceRemoval: report.outcome,
        workspaceKeptReason: report.outcome === "kept" ? report.reason : null,
      }),
    });

    return { ok: true, value: undefined };
  }

  get(id: string): Session | undefined {
    const session = this.#store.get(id);

    return session && this.#view(session);
  }

  // Sessions no online runner in the pool can take now, for a plugin that
  // starts runners on demand (ADR 0032): those beyond the room its runners
  // have, and those held by a runner that went away. A Session that only an
  // online runner can take waits for it, since a new runner never gets it,
  // and one that can move waits for its runner's lease to lapse.
  unplaced(environmentId: string): readonly Session[] {
    const environment = this.#environments
      .all()
      .find(({ id }) => id === environmentId);

    if (environment === undefined) {
      return [];
    }

    const { provider } = environment;
    const runners = this.#environments.runners(provider);
    const online = runners.filter((runner) => runner.online);

    const room = new Map(
      online.map(({ name, capacity }) => [
        name,
        capacity === null
          ? Infinity
          : capacity - this.#store.byRunner(provider, name, attempting).length,
      ]),
    );

    const takesSlot = (session: StoredSession): boolean => {
      const runner = online.find(
        ({ name }) =>
          (room.get(name) ?? 0) > 0 &&
          this.#environments.mayTake(provider, session, name),
      );

      if (runner !== undefined) {
        room.set(runner.name, (room.get(runner.name) ?? 0) - 1);
      }

      return runner !== undefined;
    };

    const unclaimed = (session: StoredSession): boolean =>
      !online.some(({ name }) => name === session.runner) &&
      !takesSlot(session) &&
      (session.runner === null
        ? this.#environments.placesOnNewRunner(provider, session)
        : !movable(session.workspace) ||
          this.#environments.leaseLapsed(provider, session.runner));

    // A Session with a runner of its own waits for it while it is online.
    return this.#store
      .byEnvironment(provider, [...claimableStatuses, ...attempting])
      .filter((session) =>
        runners.some(({ inventory }) => inventory.session === session.id)
          ? !online.some(({ inventory }) => inventory.session === session.id)
          : unclaimed(session),
      )
      .map((session) => this.#view(session));
  }

  // A runner polls for the Environment whose pool it joins (ADR 0032).
  async claim(
    runner: { readonly name: string; readonly environment: string },
    { running, folders, models, registeredModels, capacity, session }: WorkPoll,
    signal: AbortSignal,
  ): Promise<Claim> {
    const endPoll = this.#environments.beginPoll(runner, {
      capacity: capacity ?? null,
      inventory: { folders, models, ...(session !== undefined && { session }) },
      registeredModels,
    });

    const work = (): Omit<Claim, "interrupted"> => ({
      start: signal.aborted
        ? []
        : this.#claimNext(runner, capacity, running.length),
      unload: this.#stale(running),
      remove: this.#removals(runner),
    });

    try {
      const interrupted = this.#interruptMissing(runner, running);
      const first = work();
      if (first.start.length > 0 || first.unload.length > 0 || signal.aborted) {
        return { ...first, interrupted };
      }

      await this.#environments.waitForWork(
        runner.environment,
        runner.name,
        signal,
      );

      return { ...work(), interrupted };
    } finally {
      endPoll();
    }
  }

  // Kept for the repository, so later Sessions in it don't ask again.
  trust(id: string, answer: TrustAnswer): Result<undefined> {
    const current = this.#current(id, answer.generation);
    if (!current.ok) {
      return current;
    }

    const repository = trustedRepository(current.value.workspace);
    if (repository !== undefined) {
      this.#store.setRepositoryTrust(
        this.#person(current.value) ?? teamOwner,
        repository,
        answer.trusted,
      );
    }

    return { ok: true, value: undefined };
  }

  #trusted(session: StoredSession): boolean | null {
    const repository = trustedRepository(session.workspace);

    return repository === undefined
      ? null
      : this.#store.repositoryTrust(
          this.#person(session) ?? teamOwner,
          repository,
        );
  }

  fail(id: string, failure: StartFailure): Result<undefined> {
    const current = this.#current(id, failure.generation);
    if (!current.ok) {
      return current;
    }

    this.#update({ ...current.value, status: "failed", error: failure.error });

    return { ok: true, value: undefined };
  }

  appendTranscript(id: string, batch: TranscriptBatch): Result<TranscriptAck> {
    const session = this.#store.get(id);
    if (!session) {
      return { ok: false, reason: "not_found" };
    }

    // An archived attempt still flushes its last lines while it unloads, so a
    // batch is stale only before the first attempt or after a newer one.
    if (session.generation === 0 || session.generation !== batch.generation) {
      return { ok: false, reason: "stale_generation" };
    }

    const length = this.#store.transcriptLength(id);

    const fresh =
      batch.start <= length ? batch.lines.slice(length - batch.start) : [];

    if (fresh.length > 0) {
      this.#store.appendTranscript(id, length, fresh);

      const title = titleAfter(session.title, fresh);
      if (title !== session.title && title !== null) {
        this.#store.setTitle(id, title);
      }

      const model = modelAfter(session.model, fresh);
      if (model !== session.model && model !== null) {
        this.#store.setModel(id, model);
      }

      if (title !== session.title || model !== session.model) {
        this.#emit(id, {
          type: "session",
          session: this.#view({ ...session, title, model }),
        });
      }

      fresh.forEach((entry, i) => {
        this.#emit(id, { type: "entry", line: length + i, entry });
      });
    }

    return { ok: true, value: { acked: length + fresh.length } };
  }

  publish(id: string, post: LivePost): Result<undefined> {
    const current = this.#current(id, post.generation);
    if (!current.ok) {
      return current;
    }

    let session = current.value;
    for (const event of post.events) {
      if (event.type === "status") {
        const turnStarted =
          session.status !== "running" && event.status === "running";

        const turnEnded =
          session.status === "running" && event.status === "idle";

        session = { ...session, status: event.status };
        this.#update(session);
        if (turnStarted) {
          this.#events({ type: "TurnStarted", session: this.#view(session) });
        }

        if (turnEnded) {
          this.#events({
            type: "TurnEnded",
            session: this.#view(session),
            ...(event.transcriptLength !== undefined && {
              transcriptLength: event.transcriptLength,
            }),
          });
        }
      }

      const waiting = this.#waiting(session);
      this.#trackSurface(id, post.generation, event);

      if (this.#waiting(session) !== waiting) {
        const view = this.#view(session);
        this.#emit(id, { type: "session", session: view });

        if (view.waiting) {
          this.#events({
            type: "SessionWaiting",
            session: view,
            ...(event.type === "prompt" &&
              event.prompt.kind === "questions" &&
              event.prompt.for !== undefined && { for: event.prompt.for }),
          });
        }
      }

      this.#emit(id, { type: "live", event });
    }

    return { ok: true, value: undefined };
  }

  watch(
    id: string,
    listener: Listener<SessionEvent>,
    fromLine = 0,
  ): Result<{
    readonly replay: readonly SessionEvent[];
    readonly stop: () => void;
  }> {
    const session = this.#store.get(id);
    if (!session) {
      return { ok: false, reason: "not_found" };
    }

    const watchers = this.#watchers.get(id) ?? new Set();
    this.#watchers.set(id, watchers);
    watchers.add(listener);

    const replay: SessionEvent[] = [
      { type: "session", session: this.#view(session) },
      ...this.#store.transcript(id, fromLine).map((entry, i): SessionEvent => ({
        type: "entry",
        line: fromLine + i,
        entry,
      })),
      ...this.#voices(id).map((voice): SessionEvent => ({
        type: "voice",
        voice,
      })),
      ...this.#openSurfaces(session).map((event): SessionEvent => ({
        type: "live",
        event,
      })),
    ];

    return {
      ok: true,
      value: {
        replay,
        stop: () => {
          watchers.delete(listener);
          if (watchers.size === 0 && this.#watchers.get(id) === watchers) {
            this.#watchers.delete(id);
          }
        },
      },
    };
  }

  send(
    id: string,
    command: Command,
    quote?: Quote,
  ): Result<undefined, "not_found" | "archived" | "offline"> {
    const session = this.#store.get(id);
    if (!session) {
      return { ok: false, reason: "not_found" };
    }

    if (session.archivedAt !== null) {
      return { ok: false, reason: "archived" };
    }

    const host = this.#hosts.get(id);
    if (!this.#online(session)) {
      return { ok: false, reason: "offline" };
    }

    const held =
      !host &&
      command.type === "message" &&
      unhosted.includes(session.status) &&
      this.#hostedGeneration.get(id) !== session.generation;

    if (!held && !host) {
      return { ok: false, reason: "offline" };
    }

    // A team Session keeps its messages, and with them their request ids.
    if (
      !this.#team(session) &&
      command.type === "message" &&
      command.requestId !== undefined &&
      !this.#rememberRequest(id, command.requestId)
    ) {
      return { ok: true, value: undefined };
    }

    const told = [
      ...this.#teamContext(session, command, quote),
      this.#answeredBy(session, command),
    ];

    if (!this.#voice(session, command, quote)) {
      return { ok: true, value: undefined };
    }

    if (held) {
      this.#held.set(id, [...(this.#held.get(id) ?? []), ...told]);
    } else if (!told.every((each) => host?.send(each) === true)) {
      return { ok: false, reason: "offline" };
    }

    if (command.type === "abort") {
      this.#events({
        type: "StopAsked",
        session: this.#view(session),
        actor: command.actor,
      });
    }

    return { ok: true, value: undefined };
  }

  // Durable and in order per Session: it reaches the Session once its host
  // takes commands, even after a restart of the server.
  enqueue(
    id: string,
    message: Outgoing & {
      readonly plugin?: string;
      readonly actor: Actor;
      readonly dedupe?: string;
    },
  ): Result<undefined, "not_found" | "archived"> {
    const session = this.#store.get(id);

    if (session === undefined) {
      return { ok: false, reason: "not_found" };
    }

    if (session.archivedAt !== null) {
      return { ok: false, reason: "archived" };
    }

    // Pi reads it with the team's messages, which the team sees at once.
    if (message.kind === "notice" && !message.turn && this.#team(session)) {
      this.#addVoice(id, {
        kind: "notice",
        actor: message.actor,
        at: new Date(this.#clock.now()).toISOString(),
        text: message.text,
        notice: { plugin: message.plugin ?? "", ...message.notice },
      });

      return { ok: true, value: undefined };
    }

    this.#outbox.enqueue(id, message);

    return { ok: true, value: undefined };
  }

  // A safety net for a host that came back without its stream connecting.
  flushOutbox(): void {
    this.#outbox.flushAll();
  }

  #deliver(message: Queued): Delivery {
    const session = this.#store.get(message.sessionId);

    if (session === undefined) {
      return "not_found";
    }

    if (session.archivedAt !== null) {
      return "archived";
    }

    if (
      message.kind === "tool_result" &&
      !this.#current(session.id, message.generation).ok
    ) {
      return "stale_generation";
    }

    if (!this.#hosts.has(session.id)) {
      return "waits";
    }

    return this.send(session.id, commandOf(message)).ok ? "sent" : "waits";
  }

  // An external thread, such as a Slack thread, that talks to a Session.
  // One per key per plugin, gone with the Session.
  bind(plugin: string, key: string, sessionId: string): Result<undefined> {
    if (this.#store.get(sessionId) === undefined) {
      return { ok: false, reason: "not_found" };
    }

    this.#store.bindings.bind(plugin, key, sessionId, this.#clock.now());

    return { ok: true, value: undefined };
  }

  boundTo(plugin: string, key: string): string | undefined {
    return this.#store.bindings.boundTo(plugin, key);
  }

  unbind(plugin: string, key: string): void {
    this.#store.bindings.unbind(plugin, key);
  }

  #rememberRequest(id: string, requestId: string): boolean {
    const seen = this.#requestIds.get(id) ?? new Set<string>();
    this.#requestIds.set(id, seen);
    if (seen.has(requestId)) {
      return false;
    }

    seen.add(requestId);
    const [oldest] = seen;
    if (seen.size > maxRequestIds && oldest !== undefined) {
      seen.delete(oldest);
    }

    return true;
  }

  attach(
    id: string,
    generation: number,
    send: HostSend,
    end: () => void,
  ): Result<() => void> {
    const current = this.#current(id, generation);
    if (!current.ok) {
      return current;
    }

    const host = { send, end };
    this.#hosts.get(id)?.end();
    this.#hosts.set(id, host);
    this.#hostedGeneration.set(id, generation);

    for (const command of this.#held.get(id) ?? []) {
      send(command);
    }

    this.#held.delete(id);
    this.#outbox.flush(id);

    return {
      ok: true,
      value: () => {
        if (this.#hosts.get(id) === host) {
          this.#hosts.delete(id);
        }
      },
    };
  }

  transcript(id: string): readonly string[] {
    return this.#store.transcript(id, 0);
  }

  transcriptLength(id: string): number {
    return this.#store.transcriptLength(id);
  }

  isCurrent(id: string, generation: number): boolean {
    return this.#current(id, generation).ok;
  }

  // How many Sessions a runner is running now.
  running(provider: string, runner: string): number {
    return this.#store.byRunner(provider, runner, attempting).length;
  }

  // Whether an unarchived Session still runs in the Environment.
  inUse(environmentId: string): boolean {
    return this.#store
      .list({ includeArchived: false })
      .some((session) => session.environmentId === environmentId);
  }

  #interruptMissing(
    runner: { readonly name: string; readonly environment: string },
    running: readonly Attempt[],
  ): readonly Attempt[] {
    const now = new Date(this.#clock.now()).toISOString();
    const interrupted: Attempt[] = [];
    for (const session of this.#store.byRunner(
      runner.environment,
      runner.name,
      attempting,
    )) {
      const alive = running.some(
        (attempt) =>
          attempt.sessionId === session.id &&
          attempt.generation === session.generation,
      );

      if (!alive) {
        this.#hosts.get(session.id)?.end();
        this.#update({ ...session, status: "interrupted", interruptedAt: now });

        interrupted.push({
          sessionId: session.id,
          generation: session.generation,
        });
      }
    }

    return interrupted;
  }

  #stale(running: readonly Attempt[]): readonly Attempt[] {
    return running.filter(
      (attempt) => !this.#current(attempt.sessionId, attempt.generation).ok,
    );
  }

  #removals(runner: {
    readonly name: string;
    readonly environment: string;
  }): readonly Removal[] {
    return this.#store
      .pendingRemovals(runner.environment, runner.name)
      .map(({ id, generation, workspace, workspaceRemoval }) => ({
        sessionId: id,
        generation,
        workspace,
        force: workspaceRemoval === "forced",
      }));
  }

  // A Session loads what its Profile holds at each start (ADR 0031).
  #claimNext(
    runner: { readonly name: string; readonly environment: string },
    capacity: number | undefined,
    running: number,
  ): Assignment[] {
    const free = capacity === undefined ? Infinity : capacity - running;

    // A Session still attempting on another runner is claimable only once
    // that runner's lease lapsed.
    const claimable = this.#store
      .byEnvironment(runner.environment, [...claimableStatuses, ...attempting])
      .filter(
        (session) =>
          (claimableStatuses.includes(session.status) ||
            session.runner !== runner.name) &&
          this.#environments.mayTake(runner.environment, session, runner.name),
      )
      .slice(0, Math.max(free, 0));

    return claimable
      .map((session) => this.#moveOff(session))
      .flatMap((next) => {
        let profile: ProfileFiles | undefined;
        try {
          profile = this.profileFiles(next);
        } catch (error) {
          this.#update({
            ...next,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          });

          return [];
        }

        if (!profile) {
          this.#update({
            ...next,
            status: "failed",
            error: "its Profile no longer exists",
          });

          return [];
        }

        const session: StoredSession = {
          ...next,
          runner: runner.name,
          status: "starting",
          generation: next.generation + 1,
          error: null,
        };

        this.#update(session);

        return {
          sessionId: session.id,
          generation: session.generation,
          trusted: this.#trusted(session),
          profile: { id: session.profileId, hash: profile.hash },
          ...(this.#docs && { docs: this.#docs.hash }),
          workspace: session.workspace,
          model: session.model,
          thinking: session.thinking,
          systemPrompt: session.systemPrompt,
          firstMessage: session.firstMessage,
          ...this.#pluginsOf(session),
          environment: this.#environments.sessionEnvironment(
            session.environmentId,
          ),
          ...this.#gitLoginsOf(session),
          // What this runner kept from an earlier run is older than what the
          // other runner pushed and uploaded since.
          ...(next.runner !== null &&
            next.runner !== runner.name && { fresh: true }),
        };
      });
  }

  #pluginsOf(
    session: StoredSession,
  ): Required<
    Pick<Assignment, "plugins" | "pluginSettings" | "requiredPlugins">
  > &
    Pick<Assignment, "installedParts" | "pluginConfig"> {
    const {
      plugins,
      pluginSettings,
      pluginConfig,
      ownSessionsOnly,
      loadOnly,
      installedParts,
      teamWork,
    } = this.#sessionPlugins();

    const ownedBy = this.powersOf(session);
    const limit = ownedBy === undefined ? undefined : loadOnly?.[ownedBy];
    const team = this.#team(session);

    const loaded = plugins.filter(
      (name) =>
        (limit?.includes(name) ?? true) &&
        (ownSessionsOnly?.includes(name) !== true || ownedBy === name) &&
        (!team || (teamWork?.includes(name) ?? true)),
    );

    const installed = Object.entries(installedParts ?? {}).filter(([name]) =>
      loaded.includes(name),
    );

    return {
      plugins: loaded,
      requiredPlugins: loaded.filter(
        (name) =>
          ownSessionsOnly?.includes(name) === true ||
          installed.some(([each]) => each === name),
      ),
      ...(installed.length > 0 && {
        installedParts: Object.fromEntries(installed),
      }),
      pluginSettings: Object.fromEntries(
        Object.entries(pluginSettings).filter(([name]) =>
          loaded.includes(name),
        ),
      ),
      ...(pluginConfig !== undefined && {
        pluginConfig: Object.fromEntries(
          Object.entries(pluginConfig).filter(([name]) =>
            loaded.includes(name),
          ),
        ),
      }),
    };
  }

  // The plugin whose toolsets and Session parts the Session gets: the one
  // whose Profile it runs on, or else the one that owns it (ADR 0052).
  powersOf(session: Pick<Session, "profileId" | "owner">): string | undefined {
    return (
      this.#pluginProfile(session.profileId)?.plugin ?? session.owner?.plugin
    );
  }

  // A Session another one started, such as a Project's thread, acts for
  // the user who started that one.
  #starter(actor: Actor): string | null {
    const [kind = "", id = ""] = actor.split(/:(.*)/);

    switch (kind) {
      case "user":
        return id;
      case "session":
        return this.#store.get(id)?.startedBy ?? null;
      default:
        return null;
    }
  }

  #gitLoginsOf(session: StoredSession): Pick<Assignment, "gitLogins"> {
    // Team work signs git in only as a technical user that admins let the
    // team use, never as a person (ADR 0067).
    const person = this.#team(session) ? teamOwner : session.startedBy;
    const logins = person === null ? [] : this.#gitLogins(person, session);

    return logins.length > 0 ? { gitLogins: logins } : {};
  }

  // What a runner downloads for a Profile (ADR 0041).
  docs(): ProfileFiles | undefined {
    return this.#docs;
  }

  // What a Session's runner gets of its Profile, on its starter's My
  // defaults unless it's team work (ADR 0064).
  profileFiles(
    session: Pick<StoredSession, "profileId" | "startedBy" | "environmentId">,
  ): ProfileFiles | undefined {
    const id = session.profileId;
    const personId = this.#team(session) ? null : session.startedBy;
    const provided = this.#pluginProfile(id);
    if (!provided) {
      return this.#store.profileFiles(id, personId);
    }

    const own = contentFiles(provided.profile);
    const base = this.#store.baseProfileFiles(personId);

    return base ? overBaseExtensions(base, own) : own;
  }

  #profile(id: string): (ProfileContent & { readonly id: string }) | undefined {
    return this.#pluginProfile(id)?.profile ?? this.#store.profile(id);
  }

  // A turn running on a runner whose lease lapsed is reported as interrupted,
  // as after an agent restart.
  #moveOff(session: StoredSession): StoredSession {
    if (!attempting.includes(session.status)) {
      return session;
    }

    this.#hosts.get(session.id)?.end();

    const interrupted: StoredSession = {
      ...session,
      status: "interrupted",
      interruptedAt: new Date(this.#clock.now()).toISOString(),
    };

    this.#update(interrupted);

    return interrupted;
  }

  // A command stream whose tunnel died can stay open for minutes, so an
  // offline runner's streams are ended and the agent opens new ones.
  runnerChanged(environment: string, runner: string): void {
    const online = this.#environments.online(environment, runner);

    const sessions = this.#store
      .list({ includeArchived: true })
      .filter(
        (session) =>
          session.provider === environment &&
          (session.runner === runner || session.runner === null),
      );

    for (const session of sessions) {
      if (online) {
        this.#outbox.flush(session.id);
      } else {
        this.#hosts.get(session.id)?.end();
      }

      this.#emit(session.id, { type: "session", session: this.#view(session) });
    }
  }

  #trackSurface(id: string, generation: number, event: LiveEvent): void {
    const surface = liveSurface(event);
    if (surface === undefined) {
      return;
    }

    let tracked = this.#surfaces.get(id);
    if (tracked?.generation !== generation) {
      tracked = { generation, events: new Map() };
      this.#surfaces.set(id, tracked);
    }

    tracked.events.delete(surface.key);
    if (surface.open) {
      tracked.events.set(surface.key, event);
    }
  }

  #openSurfaces(session: StoredSession): readonly LiveEvent[] {
    const tracked = this.#surfaces.get(session.id);

    return tracked?.generation === session.generation &&
      attempting.includes(session.status)
      ? [...tracked.events.values()]
      : [];
  }

  #current(id: string, generation: number): Result<StoredSession> {
    const session = this.#store.get(id);
    if (!session) {
      return { ok: false, reason: "not_found" };
    }

    if (
      session.generation !== generation ||
      !attempting.includes(session.status)
    ) {
      return { ok: false, reason: "stale_generation" };
    }

    return { ok: true, value: session };
  }

  #update(session: StoredSession): void {
    const previous = this.#store.get(session.id)?.status;
    this.#store.update(session);
    if (!attempting.includes(session.status)) {
      this.#surfaces.delete(session.id);
    }

    if (
      ![...claimableStatuses, ...unhosted, ...attempting].includes(
        session.status,
      )
    ) {
      this.#held.delete(session.id);
      this.#hostedGeneration.delete(session.id);
    }

    const view = this.#view(session);
    this.#emit(session.id, { type: "session", session: view });
    if (previous !== undefined && previous !== session.status) {
      this.#events({ type: "SessionStateChanged", session: view, previous });
    }
  }

  // A Session no runner claimed yet is online while its Environment is, and
  // one that ran is online while its runner is still in that Environment.
  #online(session: StoredSession): boolean {
    return this.#environments
      .runners(session.provider)
      .some(
        ({ name, online }) =>
          online && (session.runner === null || session.runner === name),
      );
  }

  #view(session: StoredSession): Session {
    const person = this.#person(session);

    return {
      ...session,
      ownedBy:
        this.#team(session) || person === null ? teamOwner : `person:${person}`,
      access: this.#store.access(session.id) ?? { kind: "team" },
      online: this.#online(session),
      waiting: this.#waiting(session),
    };
  }

  #waiting(session: StoredSession): boolean {
    return this.#openSurfaces(session).some(
      (event) =>
        event.type === "prompt" ||
        (event.type === "plugin" && event.waiting === true) ||
        (event.type === "pi_view" && event.dialog !== null),
    );
  }

  #emit(id: string, event: SessionEvent): void {
    if (event.type === "session") {
      this.#changed();
    }

    for (const listener of this.#watchers.get(id) ?? []) {
      listener(event);
    }
  }
}

const titleLength = 80;

const teamMessageLength = 2000;
const quoteLength = 200;

function clipped(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function voiceOf({
  actor,
  requestId: _requestId,
  ...voice
}: StoredVoice): Voice {
  return { ...voice, person: personOf(actor) ?? "pi" };
}

function commandOf(message: Queued): Command {
  const { actor } = message;

  switch (message.kind) {
    case "message":
      return {
        actor,
        type: "message",
        text: message.text,
        delivery: "followUp",
      };
    case "context":
      return { actor, type: "context", text: message.text };
    case "notice":
      return {
        actor,
        type: "notice",
        text: message.text,
        notice: { plugin: message.plugin ?? "", ...message.notice },
        turn: message.turn,
      };
    case "tool_result":
      return {
        actor,
        type: "tool_result",
        id: message.call,
        result: message.result,
      };
  }
}

function personOf(actor: Actor): string | undefined {
  const [kind = "", person = ""] = actor.split(/:(.*)/);

  return kind === "user" ? person : undefined;
}

// Pi's own session name wins; until there is one, the first user message
// names the Session.
function titleAfter(
  title: string | null,
  entries: readonly string[],
): string | null {
  let named = title;

  for (const line of entries) {
    const entry = parsed(line);

    if (entry?.type === "session_info" && typeof entry.name === "string") {
      named = entry.name;
    }

    if (named === null && entry?.type === "message") {
      named = userText(entry.message);
    }
  }

  // Only new names are cut, so a longer title given elsewhere, like a fork's,
  // stays whole.
  return named === null || named === title
    ? named
    : Array.from(named.trim()).slice(0, titleLength).join("");
}

// Pi records each switch, and restores the last one when a session resumes.
function modelAfter(
  model: ModelRef | null,
  entries: readonly string[],
): ModelRef | null {
  let current = model;

  for (const line of entries) {
    const entry = parsed(line);

    if (
      entry?.type === "model_change" &&
      typeof entry.provider === "string" &&
      typeof entry.modelId === "string" &&
      (entry.provider !== current?.provider || entry.modelId !== current.id)
    ) {
      current = { provider: entry.provider, id: entry.modelId };
    }
  }

  return current;
}

function parsed(line: string):
  | {
      type?: unknown;
      name?: unknown;
      message?: unknown;
      provider?: unknown;
      modelId?: unknown;
      id?: unknown;
      parentId?: unknown;
    }
  | undefined {
  try {
    const value: unknown = JSON.parse(line);

    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

function userText(message: unknown): string | null {
  if (typeof message !== "object" || message === null) {
    return null;
  }

  const { role, content } = message as { role?: unknown; content?: unknown };
  if (role !== "user") {
    return null;
  }

  if (typeof content === "string") {
    return content;
  }

  const text = Array.isArray(content)
    ? (content as { type?: unknown; text?: unknown }[]).find(
        (part) => part.type === "text" && typeof part.text === "string",
      )?.text
    : undefined;

  return typeof text === "string" && text.trim() !== "" ? text : null;
}

// The entries from the root up to a user message's parent, through Pi's
// parentId links, so later entries and other branches stay behind. The
// header stays first, since Pi finds a session file by it.
function branchBefore(
  lines: readonly string[],
  entryId: string,
): { readonly lines: readonly string[]; readonly text: string } | undefined {
  const entries = lines.map(parsed);

  const parents = new Map<unknown, unknown>(
    entries.flatMap((entry) => (entry ? [[entry.id, entry.parentId]] : [])),
  );

  const target = entries.find((entry) => entry?.id === entryId);
  const message = target?.type === "message" ? target.message : undefined;

  if (
    typeof message !== "object" ||
    message === null ||
    (message as { role?: unknown }).role !== "user"
  ) {
    return undefined;
  }

  const kept = new Set<unknown>();

  for (
    let at = parents.get(entryId);
    typeof at === "string" && !kept.has(at);
    at = parents.get(at)
  ) {
    kept.add(at);
  }

  return {
    lines: lines.filter((_, index) => {
      const entry = entries[index];

      return entry?.type === "session" || kept.has(entry?.id);
    }),
    text: userText(message) ?? "",
  };
}

// A Session that never started has no branch yet, so its fork starts where
// it would have. An archived one's branch lives on only at its restore point.
// Otherwise the fork starts from the Session's branch, which a clone gets only
// from the remote, so its runner can say when that branch isn't pushed.
function forkedWorkspace({
  workspace,
  generation,
}: StoredSession): WorkspaceRequest {
  if (workspace.kind === "folder") {
    return workspace;
  }

  const from = (
    startPoint: string | undefined,
    restorePoint: string | undefined,
  ): { readonly startPoint?: string; readonly forked?: true } => {
    if (generation === 0) {
      return startPoint === undefined ? {} : { startPoint };
    }

    return restorePoint === undefined
      ? { startPoint: workspace.branch, forked: true }
      : { startPoint: restorePoint };
  };

  if (workspace.kind === "repositories") {
    return {
      kind: "repositories",
      repositories: workspace.repositories.map((checkout) => ({
        repository: checkout.repository,
        ...from(checkout.startPoint, checkout.restorePoint),
      })),
    };
  }

  const start = from(workspace.startPoint, workspace.restorePoint);

  return workspace.kind === "worktree"
    ? {
        kind: "worktree",
        path: workspace.path,
        ...(start.startPoint !== undefined && { startPoint: start.startPoint }),
      }
    : { kind: "clone", repository: workspace.repository, ...start };
}

// The same repositories from where the Session started, without its branch.
function freshWorkspace(workspace: Workspace): WorkspaceRequest | undefined {
  const at = (startPoint: string | undefined): { startPoint?: string } =>
    startPoint === undefined ? {} : { startPoint };

  switch (workspace.kind) {
    case "repositories":
      return {
        kind: "repositories",
        repositories: workspace.repositories.map((checkout) => ({
          repository: checkout.repository,
          ...at(checkout.startPoint),
        })),
      };
    case "clone":
      return {
        kind: "clone",
        repository: workspace.repository,
        ...at(workspace.startPoint),
      };
    case "folder":
    case "worktree":
      return undefined;
  }
}
