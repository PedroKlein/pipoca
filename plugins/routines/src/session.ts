import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { SessionCloud, SessionPlugin } from "@pipoca/plugins";

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

const Params = Type.Object({
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
        'For create and update, the whole routine: { "title", "triggers": [{ "cron": "0 8 * * 1-5", "timeZone": "Europe/Berlin" } | { "at": ISO time with zone } | { "event": "<plugin>.<name>", "filter": { field: value } }], "run": { "prompt", "workspace": { "kind": "clone", "repository": url } | { "kind": "folder", "path" }, "environment"?, "profile"?, "model"?: "provider/id", "as"?: technical user name to act as on git instead of the user } or { "prompt", "session": id }, "overlap"?: "skip" | "queue", "key"?: [event fields] }',
    }),
  ),
  summary: Type.Optional(
    Type.String({
      description:
        "For create and update, what the routine does and when, in plain words the user checks before allowing it, such as: Every weekday at 08:00 Berlin time, summarise new issues in o/r.",
    }),
  ),
});

// The agent's way to make and change the person's routines (ADR 0059).
// Making or changing one spends tokens on a schedule, so it asks first.
export const routines: SessionPlugin = {
  name: "routines",
  extension: (cloud) => (pi) => {
    pi.registerTool(
      defineTool({
        name: "routines",
        label: "Routines",
        description:
          "Make and change the user's routines: prompts that run on a schedule or on an event, each time in a new Session of their own or as a message to one Session. Use it when the user asks for something to happen regularly or when something happens. On create, the routine runs once at once as a test. Look at the result with get. For one later check of your own, use schedule_wakeup instead.",
        parameters: Params,
        annotations: { readOnlyHint: false, destructiveHint: true },
        execute: async (_id, input, signal) => {
          const text = await act(cloud, input, signal);

          return {
            content: [{ type: "text" as const, text }],
            details: {},
          };
        },
      }),
    );
  },
};

async function act(
  cloud: SessionCloud,
  {
    action,
    name = "",
    routine,
    summary,
  }: {
    action: (typeof actions)[number];
    name?: string;
    routine?: unknown;
    summary?: string;
  },
  signal: AbortSignal | undefined,
): Promise<string> {
  const path = `routines/${encodeURIComponent(name)}`;

  if (action === "list") {
    return answer(cloud.request("routines"));
  }

  if (name === "") {
    throw new Error(`${action} needs the routine's name`);
  }

  switch (action) {
    case "get":
      return answer(cloud.request(path));
    case "create":
    case "update": {
      if (summary === undefined || summary.trim() === "") {
        throw new Error(`${action} needs a summary in plain words`);
      }

      const exists = (await cloud.request(path)).ok;

      if (exists !== (action === "update")) {
        throw new Error(
          exists
            ? `there is a routine ${name} already; update it instead`
            : `there is no routine ${name}; create it instead`,
        );
      }

      const allowed = await cloud.askPermission(
        `${action === "create" ? "Create" : "Change"} the routine “${name}”?`,
        [
          { label: "What it does", value: summary },
          { label: "Routine", value: JSON.stringify(routine, null, 2) },
        ],
        signal,
      );

      if (allowed === "deny") {
        return `The user didn't allow ${action === "create" ? "creating" : "changing"} the routine.`;
      }

      await answer(
        cloud.request(path, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(routine),
        }),
      );

      if (action === "update") {
        return `Changed the routine ${name}.`;
      }

      const run = await answer(
        cloud.request(`${path}/run`, { method: "POST" }),
      );

      return `Created the routine ${name} and ran it once as a test: ${run}\nTell the user what it does and when, and that it is on the Routines page.`;
    }

    case "pause":
    case "resume":
    case "run":
      return answer(cloud.request(`${path}/${action}`, { method: "POST" }));
    case "remove": {
      const allowed = await cloud.askPermission(
        `Delete the routine “${name}”?`,
        [],
        signal,
      );

      return allowed === "deny"
        ? "The user didn't allow deleting the routine."
        : answer(cloud.request(path, { method: "DELETE" }));
    }
  }
}

async function answer(response: Promise<Response>): Promise<string> {
  const settled = await response;
  const text = await settled.text();

  if (!settled.ok) {
    const { message } = JSON.parse(text || "{}") as { message?: unknown };

    throw new Error(typeof message === "string" ? message : text);
  }

  return text;
}
