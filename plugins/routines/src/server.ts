import { defineServer, StringEnum, ToolError, Type } from "@pipoca/plugins";
import { routines } from "../plugin";
import { routinesEngine } from "./engine";
import { routineSchema } from "./routine";
import { wakeUps } from "./wakeups";

const wakeUpsQuery = Type.Object({ session: Type.String() });

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
          'For create and update, the whole routine: { "title", "triggers": [{ "cron": "0 8 * * 1-5", "timeZone": "Europe/Berlin" } | { "at": ISO time with zone } | { "event": "<plugin>.<name>", "filter": { field: value } } | { "webhook": true }], "run": { "prompt", "workspace": { "kind": "clone", "repository": url } | { "kind": "folder", "path" }, "environment"?, "profile"?, "model"?: "provider/id", "as"?: technical user name to act as on git instead of the user } or { "prompt", "session": id }, "overlap"?: "skip" | "queue", "key"?: [event fields], "maxRunning"?: number }',
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
    run: ({ action, name = "", routine, summary }, { owner }) => {
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

          engine.save(owner, name, routine);
          routes.topic("routines");

          if (action === "update") {
            return `Changed the routine ${name}.`;
          }

          const run = engine.runNow(owner, name);

          return `Created the routine ${name} and ran it once as a test: ${JSON.stringify(run)}\nTell the user what it does and when, and that it is on the Routines page.`;
        }

        case "pause":
        case "resume":
          engine.pause(owner, name, action === "pause");

          return JSON.stringify(engine.get(owner, name).paused);
        case "run":
          return JSON.stringify(engine.runNow(owner, name));
        case "remove":
          engine.remove(owner, name);

          return `Deleted the routine ${name}.`;
      }
    },
  });

  routes.get("events", { auth: "person" }, () => context.events.declared());

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
    { auth: "person", team: true, status: 201, changes: ["routines"] },
    ({ caller, params }) => engine.runNow(caller.owner, params.name),
  );

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
