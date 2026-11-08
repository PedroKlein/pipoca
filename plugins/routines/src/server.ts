import {
  defineServer,
  NotFound,
  StringEnum,
  ToolError,
  Type,
} from "@pipoca/plugins";
import { routines } from "../plugin";
import { routinesEngine } from "./engine";
import { routineSchema } from "./routine";
import { wakeUps } from "./wakeups";

const wakeUpsQuery = Type.Object({ session: Type.String() });

const runNow = Type.Object(
  {
    inputs: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
      ),
    ),
    // Its proposals are shown, never applied, and nothing is pushed.
    dryRun: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const replay = Type.Object(
  { dryRun: Type.Optional(Type.Boolean()) },
  { additionalProperties: false },
);

// What a run's Session part proposes (ADR 0076).
const proposal = Type.Object(
  {
    action: Type.String({ minLength: 1 }),
    input: Type.Unknown(),
    // The blob of a git bundle of the workspace branch, for a pull request.
    commits: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
  },
  { additionalProperties: false },
);

// A git bundle of a run's workspace branch is at most this big.
const maxCommitsBytes = 200 * 1024 * 1024;

const endRun = Type.Object(
  {
    result: StringEnum(["done", "nothing", "blocked"] as const),
    summary: Type.String({
      minLength: 1,
      description:
        "One line: what you did, or why there was nothing to do, or what you need from the person.",
    }),
  },
  { additionalProperties: false },
);

const actions = [
  "create",
  "list",
  "get",
  "update",
  "pause",
  "resume",
  "run",
  "remove",
] as const;

const routinesTool = Type.Object(
  {
    action: StringEnum(actions),
    name: Type.Optional(
      Type.String({
        description:
          "The routine's name: lower-case letters, digits and dashes, such as daily-issues. Every action but list needs it.",
      }),
    ),
    routine: Type.Optional(
      Type.Unknown({
        description:
          'For create and update, the whole routine: { "title", "when": [{ "kind": "schedule", "cron": "0 8 * * 1-5", "timeZone": "Europe/Berlin" } | { "kind": "once", "at": ISO time with zone } | { "kind": "event", "event": "<plugin>.<name>", "where"?: [{ "field", "is" | "isNot" | "contains" | "startsWith" | "matches" (a path glob such as docs/**): value } | { "field", "oneOf": [values] }] } | { "kind": "webhook" }, each with an optional "inputs": { name: text with {{event.<field>}} } and an optional "agent" or "workflow" that its runs start in place of the one in do], "inputs"?: { name: { "type": "string" | "number" | "boolean", "default"?, "required"? } | { "type": "oneOf", "values": [strings], "default"? } }, "sameWork"?: { "key"?: [event fields that make one piece of work], "whileRunning"?: "tell" | "skip" | "queue" }, "do": { "kind": "session", "agent"?: the name of an agent file, such as worker, "workflow"?: the name of a saved workflow, started with the inputs as its args, "prompt" (optional for a workflow), "workspace": { "kind": "clone", "repository": url } | { "kind": "folder", "path" } | { "kind": "event-repository" }, "environment"?, "profile"?, "model"?: "provider/id", "as"?: technical user name to act as on git instead of the user } or { "kind": "message", "prompt", "session": id }, "limits"?: { "maxRunning"?: number, "dailySpend"?: a cap in the currency of the server price table that pauses the routine until the next day, "timeLimit"?: running time such as "2h" (the default), "retries"?: how often a failed run starts again, "stopAfter"?: "YYYY-MM-DD" after which it pauses itself }, "actions"?: { action: max per run, or { "max", "approve": true } for a person to approve each first }, naming the actions its runs may propose, such as { "pullRequest": 1, "comment": 3 }, "proposes"?: "outside-input" (the default: runs fired by events and webhooks can\'t push or post and propose what to write instead) | "always" | "never" (runs write themselves, so text strangers write can make them write) }. Any trigger may have "windows": [{ "days": "mon-fri", "from": "09:00", "to": "18:00", "outside": "wait" | "skip", "timeZone"? }]. An event from a git host fires only for repository members unless a where condition names member or sender. The prompt and workspace may use {{event.<field>}} and {{inputs.<name>}}.',
      }),
    ),
    inputs: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
        { description: "For run, the routine's inputs by name." },
      ),
    ),
    dryRun: Type.Optional(
      Type.Boolean({
        description:
          "For run, a dry run: its proposals are shown on the Routines page and never applied.",
      }),
    ),
    summary: Type.Optional(
      Type.String({
        description:
          "For create and update, what the routine does and when, in plain words the user checks before allowing it, such as: Every weekday at 08:00 Berlin time, summarise new issues in o/r.",
      }),
    ),
  },
  { additionalProperties: false },
);

// Routines and wake-ups (ADR 0059): a person's or the team's routines, run
// on a schedule, on events or webhooks, and a Session's own wake-ups.
export const server = defineServer(routines, (context) => {
  const { routes, tools, sessions } = context;
  const wakeups = wakeUps(context);
  const engine = routinesEngine(context);

  tools.define({
    name: "end_run",
    description:
      "Ends this routine run: done when you finished the task, nothing when there was nothing to do this time, blocked when you can't go on without a person. The summary is the one line the person sees for the run. Call it once, then end your turn.",
    params: endRun,
    when: { ownSessions: true },
    exposure: "direct",
    annotations: { readOnly: false, destructive: false },
    run: ({ result, summary }, { session }) =>
      engine.endRun(session, result, summary.trim()),
  });

  // The agent's way to make and change its person's routines. A routine's
  // own runs don't get it, so routines can't make routines, and a team
  // Session doesn't, since the team's are made on the Routines page.
  tools.define({
    name: "routines",
    label: "Routines",
    description:
      "Make and change the user's routines: prompts that run on a schedule, on an event or on a webhook, each time in a new Session of their own or as a message to one Session. Use it when the user asks for something to happen regularly or when something happens. On create, the routine runs once at once as a test. Look at the result with get. For one later check of your own, use schedule_wakeup instead.",
    params: routinesTool,
    when: {
      owner: "person",
      available: (session) => session.plugin?.id !== "routines",
    },
    exposure: "deferred",
    annotations: { readOnly: false, destructive: true },
    asks: ({ action, name = "", summary = "" }) => {
      switch (action) {
        case "create":
          return `Create the routine “${name}”? ${summary}`.trim();
        case "update":
          return `Change the routine “${name}”? ${summary}`.trim();
        case "remove":
          return `Delete the routine “${name}”?`;
        case "list":
        case "get":
        case "pause":
        case "resume":
        case "run":
          return undefined;
      }
    },
    run: (
      { action, name = "", routine, summary, inputs, dryRun },
      { owner },
    ) => {
      if (action === "list") {
        return JSON.stringify(engine.list(owner));
      }

      if (name === "") {
        throw new ToolError(`${action} needs the routine's name`);
      }

      switch (action) {
        case "get": {
          const { webhook, ...detail } = engine.get(owner, name);

          // An agent learns where the webhook is, never its secret.
          return JSON.stringify({
            ...detail,
            ...(webhook && { webhook: { path: webhook.path } }),
          });
        }

        case "create":
        case "update": {
          if (summary === undefined || summary.trim() === "") {
            throw new ToolError(`${action} needs a summary in plain words`);
          }

          const exists = engine.exists(owner, name);

          if (exists !== (action === "update")) {
            throw new ToolError(
              exists
                ? `there is a routine ${name} already; update it instead`
                : `there is no routine ${name}; create it instead`,
            );
          }

          const tested = engine.save(owner, name, routine);
          routes.topic("routines");

          if (action === "update") {
            return `Changed the routine ${name}.`;
          }

          const saved = engine.get(owner, name).routine;
          const onEvents = saved?.when.some(({ kind }) => kind === "event");

          if (tested === undefined && onEvents === true) {
            return `Created the routine ${name}. No recent event matches it, so it runs first on the next one.\nTell the user what it does and when, and that it is on the Routines page.`;
          }

          const run =
            tested ??
            engine.runNow(
              owner,
              name,
              {},
              {
                dryRun: Object.keys(saved?.actions ?? {}).length > 0,
              },
            );

          return `Created the routine ${name} and ran it once as a test${tested === undefined ? "" : " on the newest event it matches"}: ${JSON.stringify(run)}\nTell the user what it does and when, and that it is on the Routines page.`;
        }

        case "pause":
        case "resume":
          engine.pause(owner, name, action === "pause");

          return JSON.stringify(engine.get(owner, name).paused);
        case "run":
          return JSON.stringify(
            engine.runNow(owner, name, inputs, { dryRun: dryRun === true }),
          );
        case "remove":
          engine.remove(owner, name);

          return `Deleted the routine ${name}.`;
      }
    },
  });

  routes.get("events", { auth: "person" }, () => context.events.declared());

  routes.get("actions", { auth: "person" }, () => context.actions.declared());

  context.blobs.acceptUploads({ maxBytes: () => maxCommitsBytes });

  // A run's Session part asks whether it proposes, and what it may.
  routes.get("run", { auth: "session" }, ({ caller }) => {
    const proposing = engine.proposing(caller.session);

    if (proposing === undefined) {
      throw new NotFound("this Session isn't a routine run that proposes");
    }

    return proposing;
  });

  routes.post(
    "proposals",
    { auth: "session", body: proposal, status: 201, changes: ["routines"] },
    ({ caller, body }) =>
      engine.propose(caller.session, {
        action: body.action,
        input: body.input,
        ...(body.commits !== undefined && { commits: body.commits }),
      }),
  );

  routes.get(
    "wakeups",
    { auth: "person", query: wakeUpsQuery },
    ({ caller, query }) =>
      sessions.sees(query.session, caller.person.id)
        ? wakeups.pending(query.session)
        : [],
  );

  routes.delete(
    "wakeups/:id",
    { auth: "person", changes: ["wakeups"] },
    ({ caller, params }) => {
      wakeups.cancel(params.id, (session) =>
        sessions.sees(session, caller.person.id),
      );

      return { ok: true };
    },
  );

  // Anyone on the team makes and changes the team's routines, as anyone
  // starts team work (ADR 0067).
  routes.get("routines", { auth: "person", team: true }, ({ caller }) =>
    engine.list(caller.owner),
  );

  routes.get(
    "routines/:name",
    { auth: "person", team: true },
    ({ caller, params }) => engine.get(caller.owner, params.name),
  );

  routes.put(
    "routines/:name",
    { auth: "person", team: true, body: routineSchema, changes: ["routines"] },
    ({ caller, params, body }) => {
      engine.save(caller.owner, params.name, body);

      return engine.get(caller.owner, params.name);
    },
  );

  routes.delete(
    "routines/:name",
    { auth: "person", team: true, changes: ["routines"] },
    ({ caller, params }) => {
      engine.remove(caller.owner, params.name);

      return { ok: true };
    },
  );

  routes.post(
    "routines/:name/run",
    {
      auth: "person",
      team: true,
      status: 201,
      body: runNow,
      changes: ["routines"],
    },
    ({ caller, params, body }) =>
      engine.runNow(caller.owner, params.name, body.inputs, {
        dryRun: body.dryRun === true,
      }),
  );

  routes.post(
    "routines/:name/runs/:id/replay",
    {
      auth: "person",
      team: true,
      status: 201,
      body: replay,
      changes: ["routines"],
    },
    ({ caller, params, body }) =>
      engine.replay(caller.owner, params.name, params.id, {
        dryRun: body.dryRun === true,
      }),
  );

  for (const decision of ["approve", "reject"] as const) {
    routes.post(
      `routines/:name/proposals/:id/${decision}`,
      { auth: "person", team: true, changes: ["routines"] },
      async ({ caller, params }) => {
        await engine.decide(
          caller.owner,
          params.name,
          params.id,
          decision === "approve",
          caller.person.id,
        );

        return engine.get(caller.owner, params.name);
      },
    );
  }

  for (const action of ["pause", "resume"] as const) {
    routes.post(
      `routines/:name/${action}`,
      { auth: "person", team: true, changes: ["routines"] },
      ({ caller, params }) => {
        engine.pause(caller.owner, params.name, action === "pause");

        return engine.get(caller.owner, params.name);
      },
    );
  }

  routes.post(
    "hooks/:id",
    {
      auth: { webhook: { secret: ({ id = "" }) => engine.hookSecret(id) } },
      status: 202,
    },
    async ({ params, raw }) => {
      engine.hook(params.id, await raw.text());

      return { ok: true };
    },
  );
});
