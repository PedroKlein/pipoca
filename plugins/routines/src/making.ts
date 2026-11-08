import {
  BadRequest,
  NotFound,
  type Owner,
  type ServerContext,
  type Session,
  ToolError,
  Type,
} from "@pipoca/plugins";
import {
  type DeclaredAction,
  type DeclaredEvent,
  emptyProfile,
} from "@pipoca/protocol";
import type { routines } from "../plugin";
import type { Routines } from "./engine";
import type { RoutineDraft } from "./model";
import {
  allowedActions,
  checkEvents,
  namePattern,
  routineOf,
  routineSchema,
} from "./routine";

interface Kept extends RoutineDraft {
  readonly owner: Owner;
  readonly by: string;
  readonly at: number;
  readonly tries: number;
}

const ask = Type.Object(
  {
    sentence: Type.String({ minLength: 1, maxLength: 2000 }),
    timeZone: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  },
  { additionalProperties: false },
);

const drafted = Type.Object(
  {
    name: Type.String({
      description:
        "Lower-case letters, digits and dashes, such as docs-from-merges",
    }),
    routine: Type.Unknown({ description: "The whole routine as JSON" }),
    summary: Type.String({
      minLength: 1,
      description: "One line in plain words: what it does and when",
    }),
  },
  { additionalProperties: false },
);

const invoke = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    inputs: Type.Record(Type.String(), Type.String()),
  },
  { additionalProperties: false },
);

const draftKey = "drafts/";

// A draft is gone this long after it was asked for, and a model gets this
// many tries to draft one that fits.
const keptMs = 60 * 60_000;
const maxTries = 3;

type Context = Pick<
  ServerContext<typeof routines>,
  | "routes"
  | "tools"
  | "sessions"
  | "events"
  | "actions"
  | "provide"
  | "clock"
  | "log"
>;

// Why the value can't be saved as the owner's routine, or undefined when
// it can, as saving checks it.
export function problemOf(
  value: unknown,
  owner: Owner,
  declared: {
    readonly events: readonly DeclaredEvent[];
    readonly actions: readonly DeclaredAction[];
  },
): string | undefined {
  try {
    const routine = routineOf(value);
    checkEvents(routine, declared.events);
    allowedActions(routine, declared.actions);

    return owner === "team" && routine.do.kind === "message"
      ? "a team routine starts a Session of its own each time"
      : undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// Making routines (ADR 0075): a sentence drafted into a routine by a short
// Session of the plugin's, since the server has no model of its own to
// ask, and /routine running one from any chat.
export function makingRoutines(context: Context, engine: Routines): void {
  const { routes, tools, sessions, events, actions, clock, log } = context;
  const drafts = new Map<string, Kept>();

  // A draft only writes JSON, so its Session gets none of Pi's tools.
  const drafter = context.provide.profile(
    "drafter",
    {
      ...emptyProfile,
      name: "Routine drafter",
      settings: { defaultTools: ["-read", "-bash", "-edit", "-write"] },
    },
    { team: true },
  );

  const changed = (): void => {
    routes.topic("routines");
  };

  const keep = (draft: Kept): void => {
    drafts.set(draft.id, draft);
    changed();
  };

  const draftOf = (session: Session): Kept | undefined => {
    const key = session.plugin?.key ?? "";

    return key.startsWith(draftKey)
      ? drafts.get(key.slice(draftKey.length))
      : undefined;
  };

  const viewOf = (draft: Kept): RoutineDraft => ({
    id: draft.id,
    sentence: draft.sentence,
    state: draft.state,
    sessionId: draft.sessionId,
    name: draft.name,
    routine: draft.routine,
    summary: draft.summary,
    error: draft.error,
  });

  const declared = () => ({
    events: events.declared(),
    actions: actions.declared(),
  });

  routes.post(
    "drafts",
    {
      auth: "person",
      team: true,
      body: ask,
      status: 201,
      changes: ["routines"],
    },
    ({ caller, body }) => {
      const now = clock.now();

      for (const [id, each] of drafts) {
        if (each.at < now - keptMs) {
          drafts.delete(id);
        }
      }

      const id = Bun.randomUUIDv7();
      const team = caller.owner === "team";
      let session: Session;

      try {
        session = sessions.start({
          key: `${draftKey}${id}`,
          actor: `user:${caller.person.id}`,
          ...(team && { team, access: { kind: "named", people: [] } }),
          profile: drafter,
          workspace: { kind: "repositories", repositories: [] },
          systemPrompt: draftPrompt(
            team,
            body.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
            declared(),
          ),
          firstMessage: body.sentence,
        });
      } catch (error) {
        throw new BadRequest(
          `Pipoca can't draft it now: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const draft: Kept = {
        id,
        sentence: body.sentence,
        state: "drafting",
        sessionId: session.id,
        owner: caller.owner,
        by: caller.person.id,
        at: now,
        tries: 0,
      };

      keep(draft);
      log("routine draft started", { id, sessionId: session.id });

      return viewOf(draft);
    },
  );

  routes.get(
    "drafts/:id",
    { auth: "person", team: true },
    ({ caller, params }) => {
      const draft = drafts.get(params.id);

      if (draft?.owner === caller.owner && draft.by === caller.person.id) {
        return viewOf(draft);
      }

      throw new NotFound(`no draft ${params.id}`);
    },
  );

  tools.define({
    name: "draft_routine",
    label: "Draft routine",
    description:
      "Hands the routine you drafted from the person's sentence to the Routines page, where they change and save it. It refuses a routine that doesn't fit and says why; fix it and call again.",
    params: drafted,
    when: {
      ownSessions: true,
      available: (session) => session.plugin?.key.startsWith(draftKey) === true,
    },
    exposure: "direct",
    annotations: { readOnly: true },
    run: ({ name, routine, summary }, { session }) => {
      const draft = draftOf(session);

      if (draft?.state !== "drafting") {
        throw new ToolError("this draft is done; stop here");
      }

      const error = namePattern.test(name)
        ? problemOf(routine, draft.owner, declared())
        : "name must be lower-case letters, digits and dashes";

      const tries = draft.tries + 1;

      keep({
        ...draft,
        name,
        routine,
        summary,
        tries,
        error,
        state: error === undefined || tries >= maxTries ? "ready" : "drafting",
      });

      if (error !== undefined && tries < maxTries) {
        throw new ToolError(`${error}. Fix it and call draft_routine again.`);
      }

      return {
        text: "The person has the draft on the Routines page. Stop here.",
        endsTurn: true,
      };
    },
  });

  events.on("TurnEnded", ({ session }) => {
    const draft = draftOf(session);

    if (draft === undefined) {
      return;
    }

    if (draft.state === "drafting") {
      keep({
        ...draft,
        state: draft.routine === undefined ? "failed" : "ready",
        error:
          draft.error ??
          "Pipoca didn't draft a routine from that. Say a little more, or pick it step by step.",
      });
    }

    sessions.archive(session.id);
  });

  events.on("SessionStateChanged", ({ session }) => {
    const draft = draftOf(session);

    if (draft?.state === "drafting" && session.status === "failed") {
      keep({
        ...draft,
        state: "failed",
        error: session.error ?? "the draft's Session failed",
      });
    }
  });

  // /routine <name> key=value from a chat. A run's own Session can't start
  // a routine, so runs can't chain around the depth limit.
  routes.post(
    "invoke",
    { auth: "session", body: invoke, status: 201, changes: ["routines"] },
    ({ caller, body }) => {
      if (caller.session.plugin?.id === "routines") {
        throw new BadRequest("a routine's own run can't start a routine");
      }

      const run = engine.runNow(caller.owner, body.name, body.inputs);

      return { title: engine.get(caller.owner, body.name).title, run };
    },
  );
}

function draftPrompt(
  team: boolean,
  timeZone: string,
  declared: {
    readonly events: readonly DeclaredEvent[];
    readonly actions: readonly DeclaredAction[];
  },
): string {
  return [
    `You turn the person's one sentence into a ${team ? "team " : ""}routine for Pipoca. A routine starts a Session, or messages one, on a schedule, on an event or on a webhook. You don't do the work itself and you use no other tool. Call draft_routine once with a short name, the routine and a one-line summary, then stop. If it refuses, fix what it names and call it again.`,
    "",
    'Keep it small: leave out what the sentence doesn\'t ask for, since the defaults apply. Put the instructions for each run in do.prompt, written to the agent that does the work. A routine that works on the repository an event names uses the workspace { "kind": "event-repository" }. A repository named by its short name is checked with a where condition on the event\'s repository field, as owner/name when you can tell the owner, and is cloned as https://github.com/owner/name when the work happens there. Name an agent only when the sentence says who does the work; the built-in ones are scout, worker, reviewer and delegate.',
    team
      ? "This is a team routine: it can't message a Session, so do.kind is session."
      : "",
    `Schedules use 5-field cron in the time zone ${timeZone} unless the sentence names another.`,
    "",
    "The events a trigger can name, each with its fields:",
    ...declared.events.map(
      (each) =>
        `- ${each.type}: ${each.title}. Fields: ${fieldsText(each.fields)}`,
    ),
    "",
    declared.actions.length === 0
      ? "No plugin offers actions runs may propose."
      : "The actions a routine's runs may propose, for its actions map:",
    ...declared.actions.map((each) => `- ${each.type}: ${each.title}`),
    "",
    "The routine as JSON Schema:",
    JSON.stringify(routineSchema),
  ]
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n");
}

function fieldsText(schema: Readonly<Record<string, unknown>>): string {
  const properties = schema["properties"];

  if (typeof properties !== "object" || properties === null) {
    return "any";
  }

  return Object.entries(properties as Record<string, { type?: unknown }>)
    .map(([name, each]) => `${name} (${typeOf(each)})`)
    .join(", ");
}

function typeOf(schema: {
  readonly type?: unknown;
  readonly items?: unknown;
}): string {
  if (schema.type === "array") {
    return `list of ${typeOf(schema.items ?? {})}`;
  }

  return typeof schema.type === "string" ? schema.type : "any";
}
