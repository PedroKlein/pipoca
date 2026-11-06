import {
  BadRequest,
  defineServer,
  Forbidden,
  HttpError,
  NotFound,
  type PersonCaller,
  type ServerContext,
  type SessionCaller,
  type Static,
  StringEnum,
  Type,
} from "@pipoca/plugins";
import { type Actor, checkoutName } from "@pipoca/protocol";
import { projects } from "../plugin";
import { assistantProfiles } from "./assistant";
import {
  type Membership,
  nameRule,
  type ProjectSummary,
  type ProjectView,
  sizeRule,
  validName,
  workStates,
} from "./model";
import {
  coordinatorPrompt,
  handoffText,
  runState,
  threadNotice,
  threadView,
} from "./prompts";
import { type Member, type Project, projectStore } from "./store";
import { modelRef, projectTools } from "./tools";

type Context = ServerContext<typeof projects>;

const settingsFields = {
  name: Type.Optional(Type.String()),
  goal: Type.Optional(
    Type.String({
      description:
        "The outcome the Project works toward, in a sentence or two in the user's words. Not the steps to get there, and nothing from the conversation that led to the Project.",
    }),
  ),
  instructions: Type.Optional(
    Type.String({
      description:
        "Lasting conventions every Session in the Project follows, such as how to test or which branch to target. Only what holds for the Project's whole life: leave out the request's history, tool names, ids, and anything the repositories already say. Usually empty at first.",
    }),
  ),
  threadModel: Type.Optional(
    Type.String({
      description: "provider/id of the model thread Sessions use",
    }),
  ),
  // Null takes the Project's Profile away.
  profile: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description: "Profile id, or null for the default Profile",
    }),
  ),
};

const settingsChange = Type.Object(settingsFields);

const newProject = Type.Object({
  ...settingsFields,
  name: Type.String(),
  repositories: Type.Array(Type.String(), {
    description:
      "Clone URLs of git repositories, such as https://github.com/owner/name.git, each with a different name. Use URLs the user gave or a tool found, never guessed ones. A folder that isn't a git repository can't be one.",
  }),
  environment: Type.Optional(Type.String({ description: "Environment id" })),
  model: Type.Optional(
    Type.String({ description: "provider/id of the coordinator's model" }),
  ),
});

const assistantAsk = Type.Object({
  text: Type.String({ minLength: 1 }),
  model: Type.Optional(Type.String()),
});

const stateChange = Type.Object({ state: StringEnum(workStates) });

const fileContent = Type.Object({ content: Type.String() });

const installation = Type.Union([
  Type.Object({
    kind: Type.Literal("profile"),
    files: Type.Record(Type.String(), Type.String()),
    name: Type.String({ minLength: 1 }),
    id: Type.Optional(Type.String({ minLength: 1 })),
  }),
  Type.Object({
    kind: Type.Literal("plugin"),
    plugin: Type.String({ minLength: 1 }),
    files: Type.Record(Type.String(), Type.String()),
  }),
]);

const errorLimit = 300;
const transcriptWaitMs = 1000;

// A runner can die between TurnEnded and its upload, so a report stops
// waiting for the transcript after this long.
const transcriptWaitLimitMs = 60_000;

// Projects, their coordinators and threads (ADR 0016, ADR 0028), each
// Project's library (ADR 0018), and each person's assistant, a Project of
// their own (ADR 0052).
export const server = defineServer(projects, (context) => {
  const { routes, sessions, events, schedule, transcript, log } = context;
  const store = projectStore(context.store, context.clock);

  const changed = (): void => {
    routes.topic("projects");
  };

  // The assistant's coordinator reads but changes nothing on the runner,
  // and its threads build with all of Pi's tools. Both load every route
  // tool, which act as the person (ADR 0052).
  const assistant = {
    coordinator: context.provide.profile(
      "assistant",
      assistantProfiles.coordinator,
      { team: true, routeTools: true },
    ),
    thread: context.provide.profile("builder", assistantProfiles.thread, {
      team: true,
      routeTools: true,
    }),
  };

  const coordinated = (sessionId: string): Project | undefined => {
    const member = store.member(sessionId);

    return member?.role === "coordinator"
      ? store.get(member.projectId)
      : undefined;
  };

  const report = (
    project: Project,
    message: { text: string; turn: boolean; notice: unknown; dedupe?: string },
  ): void => {
    const { text, turn, notice, dedupe } = message;

    sessions.send(project.coordinatorId, {
      text,
      turn,
      notice: notice as { kind: string; data?: unknown },
      ...(dedupe !== undefined && { dedupe }),
    });
  };

  // A thread's turn reaches its coordinator once the thread's transcript
  // holds the whole turn, which its host can upload after TurnEnded.
  const reportTurn = (
    threadId: string,
    end: number | undefined,
    wait = true,
    since = context.clock.now(),
  ): void => {
    const thread = store.member(threadId);
    const project = thread && store.get(thread.projectId);
    const session = sessions.get(threadId);

    if (thread?.role !== "thread" || project === undefined) {
      return;
    }

    if (
      wait &&
      end !== undefined &&
      session?.archivedAt === null &&
      transcript.length(threadId) < end &&
      context.clock.now() < since + transcriptWaitLimitMs
    ) {
      schedule.at(
        `turn:${threadId}:${String(end)}`,
        context.clock.now() + transcriptWaitMs,
        { threadId, end, since },
      );

      return;
    }

    const turn = transcript.lastTurn(
      threadId,
      end === undefined ? {} : { end },
    );

    const { text, notice } = threadNotice(
      thread,
      session,
      turn.error === undefined
        ? "finished a turn"
        : `ended its turn with a model error: ${turn.error.slice(0, errorLimit)}`,
      turn.reply,
    );

    if (turn.error !== undefined) {
      log("thread turn failed", { sessionId: threadId, error: turn.error });
    }

    // A thread that messaged the coordinator this turn already started a
    // coordinator turn, so its notice is only context. So is a failed turn:
    // a coordinator woken by it tends to retry the thread on the same model,
    // which fails the same way.
    report(project, {
      text,
      notice,
      turn:
        turn.error === undefined &&
        !turn.called.includes("message_coordinator"),
      dedupe: `turn:${threadId}:${String(end ?? transcript.length(threadId))}`,
    });
  };

  schedule.on("turn:", (payload) => {
    const { threadId, end, since } = payload as {
      threadId: string;
      end: number;
      since?: number;
    };

    reportTurn(threadId, end, true, since);
  });

  // A thread's later message never overtakes its last turn's report, which
  // then goes with what the transcript holds so far.
  const reportWaitingTurns = (threadId: string): void => {
    for (const { key, payload } of schedule.pending(`turn:${threadId}:`)) {
      schedule.cancel(key);
      reportTurn(threadId, (payload as { end: number }).end, false);
    }
  };

  projectTools(context, store, reportWaitingTurns);

  for (const type of ["TurnStarted", "TurnEnded"] as const) {
    events.on(type, ({ session }) => {
      if (store.member(session.id) !== undefined) {
        store.touch(session.id);
        changed();
      }
    });
  }

  events.on("TurnEnded", ({ session, transcriptLength }) => {
    reportTurn(session.id, transcriptLength);
  });

  // Once Pi compacts a coordinator's context, a fresh coordinator takes over
  // from a handoff, as Claude Code's does (ADR 0052).
  events.on("TurnEnded", ({ session }) => {
    const project = coordinated(session.id);

    if (
      project?.coordinatorId === session.id &&
      transcript.compaction(session.id) !== undefined
    ) {
      try {
        startFresh(project);
      } catch (error) {
        log("could not start a fresh coordinator", {
          project: project.id,
          error: String(error),
        });
      }
    }
  });

  // Every restart interrupts the threads it finds idle too, and those lost
  // nothing, so a notice would only cost the coordinator a turn.
  events.on("SessionStateChanged", ({ session, previous }) => {
    const thread = store.member(session.id);
    const project = thread && store.get(thread.projectId);

    if (
      thread?.role === "thread" &&
      project !== undefined &&
      ((session.status === "interrupted" && previous === "running") ||
        session.status === "failed")
    ) {
      reportWaitingTurns(session.id);

      report(project, {
        ...threadNotice(thread, session, `stopped: ${session.status}`),
        turn: true,
      });
    }

    if (thread !== undefined) {
      changed();
    }
  });

  // A Project goes and comes back with its coordinator, and takes every
  // Session it owns along (ADR 0028).
  events.on("SessionArchived", ({ session }) => {
    const project = coordinated(session.id);

    if (project === undefined) {
      return;
    }

    for (const owned of sessions.owned(project.id)) {
      try {
        sessions.archive(owned.id);
      } catch (error) {
        log("could not archive a Session with its Project", {
          sessionId: owned.id,
          error: String(error),
        });
      }
    }

    changed();
  });

  // Threads archived before the Project stay archived.
  events.on("SessionUnarchived", ({ session, archivedAt }) => {
    const project = coordinated(session.id);

    if (project === undefined) {
      return;
    }

    for (const owned of sessions.owned(project.id, { archived: true })) {
      if (owned.archivedAt === null || owned.archivedAt < archivedAt) {
        continue;
      }

      try {
        sessions.unarchive(owned.id);
      } catch (error) {
        log("could not bring back a Session with its Project", {
          sessionId: owned.id,
          error: String(error),
        });
      }
    }

    changed();
  });

  // A Project is its owner's alone (ADR 0049), or the whole team's
  // (ADR 0067). An assistant's is its person's, even the Team assistant.
  // Team work reaches only team Projects.
  const sees = (project: Project, caller: PersonCaller): boolean =>
    (caller.owner !== "team" || project.owner === "team") &&
    (project.assistantOf === null
      ? project.owner === caller.owner || project.owner === "team"
      : project.assistantOf === caller.person.id);

  const theirs = (id: string, caller: PersonCaller): Project => {
    const project = store.get(id);

    if (project === undefined || !sees(project, caller)) {
      throw new NotFound("no such Project");
    }

    return project;
  };

  const view = (project: Project): ProjectView => ({
    id: project.id,
    name: project.name,
    goal: project.goal,
    instructions: project.instructions,
    repositories: project.repositories,
    environmentId: project.environmentId,
    profileId: project.profileId,
    threadModel: project.threadModel,
    coordinatorId: project.coordinatorId,
    coordinatorState: runState(sessions.get(project.coordinatorId)),
    assistant: project.assistantOf !== null,
    team: project.owner === "team",
    formerCoordinators: store
      .formers(project.id)
      .map(({ sessionId }) => sessionId),
    threads: store
      .threads(project.id)
      .map((thread) => threadView(thread, sessions.get(thread.sessionId))),
    memory: store.memory(project.id),
  });

  const summary = (project: Project): ProjectSummary => {
    const threads = store.threads(project.id);

    return {
      id: project.id,
      name: project.name,
      coordinatorId: project.coordinatorId,
      coordinatorState: runState(sessions.get(project.coordinatorId)),
      repositories: project.repositories.length,
      threads: threads.length,
      needsYou: threads.filter(
        (thread) =>
          thread.workState === "blocked" ||
          runState(sessions.get(thread.sessionId)) === "waiting",
      ).length,
      team: project.owner === "team",
    };
  };

  const begin = (
    draft: Omit<Project, "coordinatorId" | "createdAt">,
    by: string,
    start: {
      readonly model?: string | undefined;
      readonly profile: string | null;
      readonly firstMessage?: string;
    },
  ): Project => {
    const coordinator = started(() => {
      const ref = modelRef((start.model ?? "").trim() || undefined);
      const team = draft.owner === "team";

      return sessions.start({
        key: draft.id,
        actor: `user:${by}`,
        ...(ref && { model: ref }),
        ...(team && { team: true }),
        // A Team assistant's chat is its person's alone (ADR 0067).
        ...(team &&
          draft.assistantOf !== null && {
            access: { kind: "named", people: [] },
          }),
        ...(draft.environmentId !== null && {
          environment: draft.environmentId,
        }),
        ...(start.profile !== null && { profile: start.profile }),
        workspace: {
          kind: "repositories",
          repositories: draft.repositories.map((repository) => ({
            repository,
          })),
        },
        systemPrompt: coordinatorPrompt(draft, undefined),
        ...(start.firstMessage !== undefined && {
          firstMessage: start.firstMessage,
        }),
      });
    });

    store.create(draft, coordinator.id);

    log("project created", {
      project: draft.id,
      coordinator: coordinator.id,
      ...(draft.assistantOf !== null && { assistant: true }),
    });

    return store.get(draft.id) ?? fail(draft.id);
  };

  // The old coordinator is archived but stays readable, and what waited for
  // it goes to the new one.
  const startFresh = (project: Project): Project => {
    const previous = sessions.get(project.coordinatorId);
    const compaction = transcript.compaction(project.coordinatorId);

    const handoff = handoffText(
      {
        summary: compaction?.summary,
        messages: transcript.messages(
          project.coordinatorId,
          compaction === undefined ? {} : { sinceLine: compaction.line + 1 },
        ),
      },
      store
        .threads(project.id)
        .map((thread) => threadView(thread, sessions.get(thread.sessionId))),
    );

    const environment = previous?.environmentId ?? project.environmentId;
    const profile = previous?.profileId ?? project.profileId;
    const team = project.owner === "team";

    const coordinator = started(() =>
      sessions.start({
        key: project.id,
        actor: `user:${previous?.startedBy ?? project.assistantOf ?? ""}`,
        ...(previous?.model && { model: previous.model }),
        ...(team && { team: true }),
        ...(team &&
          project.assistantOf !== null && {
            access: { kind: "named", people: [] },
          }),
        ...(environment !== null && { environment }),
        ...(profile !== null && { profile }),
        workspace: {
          kind: "repositories",
          repositories: project.repositories.map((repository) => ({
            repository,
          })),
        },
        // In the system prompt, since Pi keeps no context message in a
        // Session's file before its first reply.
        systemPrompt: `${coordinatorPrompt(
          project,
          store.readMemory(project.id, "MEMORY.md")?.content,
        )}\n\n${handoff}`,
      }),
    );

    store.replaceCoordinator(project, coordinator.id);

    try {
      sessions.archive(project.coordinatorId);
    } catch (error) {
      log("could not archive the coordinator a fresh one replaced", {
        sessionId: project.coordinatorId,
        error: String(error),
      });
    }

    log("fresh coordinator started", {
      project: project.id,
      previous: project.coordinatorId,
      coordinator: coordinator.id,
    });

    changed();

    return store.get(project.id) ?? project;
  };

  const create = (
    body: Static<typeof newProject>,
    caller: PersonCaller,
  ): Project => {
    if (body.name.trim() === "") {
      throw new BadRequest("name is required");
    }

    const urls = body.repositories.filter((url) => url.trim() !== "");
    const names = urls.map(checkoutName);

    if (
      urls.length === 0 ||
      names.includes(undefined) ||
      new Set(names).size !== names.length
    ) {
      throw new BadRequest(
        "a Project needs one or more repositories with different names",
      );
    }

    const threadModel = (body.threadModel ?? "").trim() || null;
    checkedModel(threadModel);
    const profile = (body.profile ?? "") || null;

    return begin(
      {
        id: Bun.randomUUIDv7(),
        owner: caller.owner,
        assistantOf: null,
        name: body.name.trim(),
        goal: body.goal?.trim() ?? "",
        instructions: body.instructions ?? "",
        repositories: urls,
        environmentId: (body.environment ?? "") || null,
        profileId: profile,
        threadModel,
      },
      caller.person.id,
      { model: body.model, profile },
    );
  };

  // The person's assistant, made the first time they ask it something
  // (ADR 0052). Each ask goes to its coordinator.
  const ask = (
    { text, model }: Static<typeof assistantAsk>,
    caller: PersonCaller,
  ): Project => {
    if (text.trim() === "") {
      throw new BadRequest("text must not be empty");
    }

    const found = store.assistant(caller.owner, caller.person.id);

    if (found === undefined) {
      return begin(
        {
          id: Bun.randomUUIDv7(),
          owner: caller.owner,
          assistantOf: caller.person.id,
          name: caller.owner === "team" ? "Team assistant" : "Assistant",
          goal: "",
          instructions: "",
          repositories: [],
          environmentId: null,
          profileId: assistant.thread,
          threadModel: null,
        },
        caller.person.id,
        { model, profile: assistant.coordinator, firstMessage: text },
      );
    }

    if (
      sessions.send(found.coordinatorId, {
        text,
        turn: true,
        as: `user:${caller.person.id}`,
      }) === "gone"
    ) {
      throw new BadRequest("the assistant's conversation is archived");
    }

    return found;
  };

  routes.get(
    "projects",
    {
      auth: "person",
      team: true,
      tool: {
        name: "projects_list",
        description:
          "List Projects with their coordinator, thread counts and how many threads need the user.",
        exposure: "direct",
        annotations: { readOnlyHint: true },
      },
    },
    ({ caller }): ProjectSummary[] =>
      store
        .list()
        .filter(
          (project) =>
            project.assistantOf === null && project.owner === caller.owner,
        )
        .map(summary),
  );

  routes.post(
    "projects",
    {
      auth: "person",
      team: true,
      body: newProject,
      changes: ["projects"],
      tool: {
        name: "projects_create",
        description:
          "Create a Project, which starts its coordinator Session with every repository checked out.",
        exposure: "direct",
        // It clones the repositories and starts a coordinator, whose agent
        // runs without a confirm of its own.
        annotations: { destructiveHint: false, openWorldHint: true },
        opens: (body) => {
          const { id, name } = body as ProjectView;

          return { route: id, label: `“${name}”` };
        },
      },
    },
    ({ caller, body }) => view(create(body, caller)),
  );

  routes.get(
    "projects/:id",
    {
      auth: "person",
      team: true,
      tool: {
        name: "projects_get",
        description: "Get one Project with its threads.",
        annotations: { readOnlyHint: true },
      },
    },
    ({ caller, params }) => view(theirs(params.id, caller)),
  );

  routes.post(
    "projects/:id/settings",
    {
      auth: "person",
      team: true,
      body: settingsChange,
      changes: ["projects"],
      tool: {
        name: "projects_update",
        description:
          "Change a Project's settings. Only the fields given change.",
        annotations: { destructiveHint: true },
        asks: {
          lookup: (input) =>
            `projects/${encodeURIComponent(typeof input["id"] === "string" ? input["id"] : "")}`,
          text: (_input, found) =>
            found === undefined
              ? "Change this Project's settings?"
              : `Change the settings of “${(found as ProjectView).name}”?`,
        },
      },
    },
    ({ caller, params, body }) => {
      const project = theirs(params.id, caller);
      store.update(project.id, settingsOf(project, body));

      return view(store.get(project.id) ?? project);
    },
  );

  routes.post(
    "projects/:id/fresh",
    { auth: "person", changes: ["projects"] },
    ({ caller, params }) => view(startFresh(theirs(params.id, caller))),
  );

  routes.get(
    "projects/:id/memory/:name",
    { auth: "person" },
    ({ caller, params }) => {
      const project = theirs(params.id, caller);
      const content = store.readMemory(project.id, params.name)?.content;

      if (content === undefined) {
        throw new NotFound(`no memory file ${params.name}`);
      }

      return { name: params.name, content };
    },
  );

  routes.get("threads/:id", { auth: "person" }, ({ caller, params }) => {
    const thread = store.member(params.id);

    if (thread?.role !== "thread") {
      throw new NotFound("no such thread");
    }

    theirs(thread.projectId, caller);

    return {
      projectId: thread.projectId,
      ...threadView(thread, sessions.get(thread.sessionId)),
    };
  });

  routes.post(
    "threads/:id/state",
    { auth: "person", body: stateChange, changes: ["projects"] },
    ({ caller, params, body }) => {
      const thread = store.member(params.id);

      if (thread === undefined) {
        throw new NotFound("no such thread");
      }

      theirs(thread.projectId, caller);
      store.setWorkState(thread.sessionId, body.state);

      return { ok: true };
    },
  );

  routes.get("assistant", { auth: "person", team: true }, ({ caller }) => {
    const found = store.assistant(caller.owner, caller.person.id);

    if (found === undefined) {
      throw new NotFound("no assistant yet");
    }

    return view(found);
  });

  routes.post(
    "assistant",
    { auth: "person", team: true, body: assistantAsk, changes: ["projects"] },
    ({ caller, body }) => view(ask(body, caller)),
  );

  libraryRoutes(context, store);

  // What a Session part learns of the Session it runs in.
  routes.get("member", { auth: "session" }, ({ caller }): Membership => {
    const { member, project } = memberOf(caller);

    return {
      projectId: project.id,
      role: member.role,
      assistant: project.assistantOf !== null,
    };
  });

  const memberOf = (
    caller: SessionCaller,
  ): { member: Member; project: Project } => {
    const member = store.member(caller.session.id);
    const project = member && store.get(member.projectId);

    if (member === undefined || project === undefined) {
      throw new NotFound("this Session is not in a Project");
    }

    return { member, project };
  };

  // An assistant thread installs what it built in its workspace through the
  // route tools the web UI's routes back, so it acts as the person, with the
  // same checks (ADR 0052).
  routes.post(
    "install",
    { auth: "session", body: installation },
    async ({ caller, body }) => {
      const { project } = memberOf(caller);

      if (project.assistantOf === null) {
        throw new Forbidden("only the assistant's threads install");
      }

      return body.kind === "profile"
        ? installProfile(context, caller.session.id, body)
        : installPlugin(context, caller.session.id, body);
    },
  );

  routes.get("library/:name", { auth: "session" }, ({ caller, params }) => {
    const { project } = memberOf(caller);
    const content = store.readFile(project.id, decoded(params.name));

    if (content === undefined) {
      throw new NotFound(`no library file ${params.name}`);
    }

    return { content: Buffer.from(content).toString("base64") };
  });

  routes.get("library", { auth: "session" }, ({ caller }) =>
    store.files(memberOf(caller).project.id),
  );

  routes.put(
    "library/:name",
    { auth: "session", body: fileContent, changes: ["projects"] },
    ({ caller, params, body }) => {
      const { project } = memberOf(caller);
      const content = Buffer.from(body.content, "base64");

      return writeFile(
        project.id,
        params.name,
        new Uint8Array(content),
        `session:${caller.session.id}`,
      );
    },
  );

  const writeFile = (
    projectId: string,
    rawName: string,
    content: Uint8Array,
    actor: Actor,
  ): { name: string; size: number } => {
    const name = decoded(rawName);
    const limit = context.config.get().fileLimitMb * 1024 * 1024;

    if (!validName(name)) {
      throw new BadRequest(nameRule);
    }

    if (content.length > limit) {
      throw new HttpError(413, sizeRule(limit));
    }

    store.writeFile(projectId, name, content, actor);
    log("library file written", { project: projectId, name, actor });

    return { name, size: content.length };
  };

  // The web app's half of the library, which uploads raw bytes.
  function libraryRoutes({ routes: own }: Context, files: typeof store): void {
    own.get("projects/:id/files", { auth: "person" }, ({ caller, params }) =>
      files.files(theirs(params.id, caller).id),
    );

    own.get("projects/:id/log", { auth: "person" }, ({ caller, params }) =>
      files.writes(theirs(params.id, caller).id),
    );

    own.get(
      "projects/:id/files/:name",
      { auth: "person" },
      ({ caller, params }) => {
        const project = theirs(params.id, caller);
        const name = decoded(params.name);
        const content = files.readFile(project.id, name);

        if (content === undefined) {
          throw new NotFound(`no library file ${name}`);
        }

        return new Response(content, {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": attachment(name),
          },
        });
      },
    );

    own.put(
      "projects/:id/files/:name",
      { auth: "person", changes: ["projects"] },
      async ({ caller, params, raw }) => {
        const project = theirs(params.id, caller);

        return writeFile(
          project.id,
          params.name,
          new Uint8Array(await raw.arrayBuffer()),
          `user:${caller.person.id}`,
        );
      },
    );
  }
});

function started<T>(start: () => T): T {
  try {
    return start();
  } catch (error) {
    throw new BadRequest(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function fail(id: string): never {
  throw new Error(`Project ${id} was not stored`);
}

function checkedModel(name: string | null): void {
  try {
    modelRef(name ?? undefined);
  } catch (error) {
    throw new BadRequest(`thread model: ${(error as Error).message}`);
  }
}

// The settings a Project can change after it starts. The repositories and
// Environment stay, since the coordinator's workspace was built from them.
function settingsOf(
  project: Project,
  {
    name,
    goal,
    instructions,
    threadModel,
    profile,
  }: Static<typeof settingsChange>,
): Pick<
  Project,
  "name" | "goal" | "instructions" | "threadModel" | "profileId"
> {
  if (name?.trim() === "") {
    throw new BadRequest("name must not be empty");
  }

  const model =
    threadModel === undefined
      ? project.threadModel
      : threadModel.trim() || null;

  checkedModel(model);

  const id = profile === undefined ? undefined : (profile?.trim() ?? "");
  const profileId = id === "" ? null : id;

  return {
    name: name?.trim() ?? project.name,
    goal: goal?.trim() ?? project.goal,
    instructions: instructions ?? project.instructions,
    threadModel: model,
    profileId: profileId === undefined ? project.profileId : profileId,
  };
}

// macOS and zip archives often spell "é" as "e" plus a combining accent; NFC
// makes both spellings one file.
function decoded(name: string): string {
  return name.normalize("NFC");
}

// RFC 8187 leaves ' ( ) and * out of filename*, but encodeURIComponent keeps
// them.
function attachment(name: string): string {
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `attachment; filename*=UTF-8''${encoded}`;
}

async function installProfile(
  { tools }: Context,
  session: string,
  { files, name, id }: Static<typeof installation> & { kind: "profile" },
): Promise<{ text: string; isError: boolean; opened?: unknown }> {
  let target = id;

  if (target === undefined) {
    const created = await tools.call("profiles_create", { name }, { session });

    if (created.isError) {
      return created;
    }

    target = (JSON.parse(created.text) as { id: string }).id;
  }

  const uploaded = await tools.call(
    "profiles_upload",
    { id: target, files },
    { session },
  );

  if (uploaded.isError) {
    return id === undefined
      ? {
          ...uploaded,
          text: `Made the Profile ${target}, but its files weren't written: ${uploaded.text}`,
        }
      : uploaded;
  }

  return {
    text: `Wrote ${String(Object.keys(files).length)} files into the Profile ${target}.`,
    isError: false,
    opened: { kind: "open", route: `profiles/${target}`, label: name },
  };
}

async function installPlugin(
  { tools }: Context,
  session: string,
  { plugin, files }: Static<typeof installation> & { kind: "plugin" },
): Promise<{ text: string; isError: boolean }> {
  for (const [path, content] of Object.entries(files)) {
    const written = await tools.call(
      "plugins_write_file",
      { plugin, path, content },
      { session },
    );

    if (written.isError) {
      return { ...written, text: `${path}: ${written.text}` };
    }
  }

  return tools.call("plugins_build", { plugin }, { session });
}
