import type {
  ServerPluginContext,
  ServerTool,
  ToolCaller,
} from "@pipoca/plugins";
import type { Actor, ModelRef, ToolResult } from "@pipoca/protocol";
import { type WorkState, workStates } from "./model";
import { threadNotice, threadPrompt, threadView, unreachable } from "./prompts";
import type { Member, Project, ProjectStore } from "./projects";
import { messageText } from "./transcript";

const pageSize = 20;

type Handler = (input: Record<string, unknown>, caller: Caller) => string;

interface Caller {
  readonly member: Member;
  readonly project: Project;
  readonly actor: Actor;
}

export function projectTools(
  projects: ProjectStore,
  { sessions }: Pick<ServerPluginContext, "sessions">,
): ServerTool[] {
  const result = (
    input: unknown,
    { session, actor }: ToolCaller,
    handle: Handler,
  ): ToolResult => {
    const member = projects.member(session.id);
    const project = member && projects.get(member.projectId);
    if (!member || !project) {
      return failure("this session is not in a Project");
    }

    try {
      return {
        text: handle((input ?? {}) as Record<string, unknown>, {
          member,
          project,
          actor,
        }),
        isError: false,
      };
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
  };

  const tool = (
    spec: Omit<ServerTool, "appliesTo" | "run">,
    role: Member["role"] | "both",
    handle: Handler,
  ): ServerTool => ({
    ...spec,
    appliesTo: (session) => {
      const member = projects.member(session.id);

      return member !== undefined && (role === "both" || member.role === role);
    },
    run: async (input, caller) =>
      Promise.resolve(result(input, caller, handle)),
  });

  const threadOf = (project: Project, id: unknown): Member => {
    const thread = typeof id === "string" ? projects.member(id) : undefined;
    if (thread?.projectId !== project.id || thread.role !== "thread") {
      throw new Error(`no thread ${String(id)} in this Project`);
    }

    return thread;
  };

  return [
    tool(
      {
        name: "start_thread",
        annotations: { destructiveHint: false, openWorldHint: true },
        description:
          "Start a thread: a new Pi session with its own checkout of the Project's repositories, which works on one task and reports back.",
        parameters: object(
          {
            title: text("A short name for the thread's task"),
            message: text(
              'Your brief for the thread, addressed to it: the task, what done looks like, and only the facts it needs, such as decisions the user made. Write it as an instruction ("Build…"), never as a report about the user ("User wants…")',
            ),
            repositories: {
              type: "array",
              items: { type: "string" },
              description:
                "Repository URLs to check out, a subset of the Project's. Default: all of them.",
            },
            start_points: {
              type: "object",
              additionalProperties: { type: "string" },
              description:
                "Branch, tag or commit to start each repository's branch from, keyed by repository URL. Default: the repository's default branch.",
            },
            environment: text(
              "Environment id to run in. Default: the Project's",
            ),
            profile: text(
              "Profile id to run with. Default: the Project's, else the user's default",
            ),
            model: text("Model as provider/id. Default: the coordinator's"),
          },
          ["title", "message"],
        ),
      },
      "coordinator",
      (input, { project, actor }) => {
        const title = required(input, "title");
        const message = required(input, "message");

        const repositories = Array.isArray(input["repositories"])
          ? [...new Set(input["repositories"].map(String))]
          : project.repositories;

        const unknown = repositories.filter(
          (url) => !project.repositories.includes(url),
        );

        if (
          unknown.length > 0 ||
          (repositories.length === 0 && !project.assistant)
        ) {
          throw new Error(
            `repositories must be some of: ${project.repositories.join(", ")}`,
          );
        }

        const startPoints = (input["start_points"] ?? {}) as Record<
          string,
          unknown
        >;

        const environment =
          optional(input, "environment") ?? project.environmentId ?? undefined;

        const profile =
          optional(input, "profile") ?? project.profileId ?? undefined;

        const model =
          modelRef(optional(input, "model")) ??
          modelRef(project.threadModel ?? undefined) ??
          sessions.get(project.coordinatorId)?.model ??
          undefined;

        const session = sessions.start(
          {
            actor,
            ...(environment !== undefined && { environment }),
            ...(profile !== undefined && { profile }),
            workspace: {
              kind: "repositories",
              repositories: repositories.map((repository) => {
                const startPoint = startPoints[repository];

                return typeof startPoint === "string" && startPoint !== ""
                  ? { repository, startPoint }
                  : { repository };
              }),
            },
            ...(model && { model }),
            systemPrompt: threadPrompt(
              project,
              title,
              projects.readMemory(project.id, "MEMORY.md")?.content,
            ),
          },
          project.id,
        );

        // The brief is the coordinator's, so the thread's chat shows it as
        // such, not as the person's message.
        projects.enqueue(session.id, actor, {
          kind: "message",
          text: message,
          notice: { kind: "coordinator_message", data: { text: message } },
        });

        projects.addMember({
          sessionId: session.id,
          projectId: project.id,
          role: "thread",
          title,
          workState: "in_progress",
          lastActivity: new Date().toISOString(),
        });

        return `Started thread "${title}" as ${session.id}.`;
      },
    ),
    tool(
      {
        name: "message_thread",
        annotations: { destructiveHint: false },
        description:
          "Send a message to a thread. It starts a turn, or waits as a follow-up if the thread is busy.",
        parameters: object(
          { thread: text("The thread's id"), text: text("The message") },
          ["thread", "text"],
        ),
      },
      "coordinator",
      (input, { project, actor }) => {
        const thread = threadOf(project, input["thread"]);

        const refused = unreachable(
          `thread "${thread.title}"`,
          sessions.get(thread.sessionId),
        );

        if (refused !== undefined) {
          throw new Error(refused);
        }

        const said = required(input, "text");

        projects.enqueue(thread.sessionId, actor, {
          kind: "message",
          text: said,
          notice: { kind: "coordinator_message", data: { text: said } },
        });

        return `Message queued for thread "${thread.title}".`;
      },
    ),
    tool(
      {
        name: "list_threads",
        annotations: { readOnlyHint: true },
        description:
          "List the Project's threads with their title, run state, work state, Environment, branch and last activity.",
        parameters: object({}, []),
      },
      "coordinator",
      (_input, { project }) => {
        const threads = projects.threads(project.id);
        if (threads.length === 0) {
          return "No threads yet.";
        }

        return threads
          .map((thread) => {
            const view = threadView(thread, sessions.get(thread.sessionId));

            return `${view.sessionId} · "${view.title}" · run: ${view.runState} · work: ${view.workState} · environment: ${view.environmentId === "" ? "?" : view.environmentId} · branch: ${view.branch ?? "none"} · last activity: ${view.lastActivity}`;
          })
          .join("\n");
      },
    ),
    tool(
      {
        name: "read_thread",
        annotations: { readOnlyHint: true },
        description: `Read a thread's messages, newest first, ${String(pageSize)} per page.`,
        parameters: object(
          {
            thread: text("The thread's id"),
            page: { type: "number", description: "Page number, from 1" },
          },
          ["thread"],
        ),
      },
      "coordinator",
      (input, { project }) => {
        const thread = threadOf(project, input["thread"]);
        const page = Math.max(1, Math.floor(Number(input["page"] ?? 1)) || 1);

        const messages = sessions
          .transcript(thread.sessionId)
          .flatMap((line) => messageText(line) ?? []);

        const end = messages.length - (page - 1) * pageSize;

        const shown =
          end > 0 ? messages.slice(Math.max(0, end - pageSize), end) : [];

        if (shown.length === 0) {
          return `Thread "${thread.title}" has no messages on page ${String(page)}.`;
        }

        return [
          `Thread "${thread.title}", page ${String(page)} of ${String(Math.ceil(messages.length / pageSize))}, oldest first:`,
          ...shown.map(({ role, text: said }) => `[${role}] ${said}`),
        ].join("\n\n");
      },
    ),
    tool(
      {
        name: "message_coordinator",
        annotations: { destructiveHint: false },
        description:
          "Send a message to the Project's coordinator. It starts a coordinator turn, so use it for decisions and results, not progress.",
        parameters: object({ text: text("The message") }, ["text"]),
      },
      "thread",
      (input, { member, project, actor }) => {
        const said = required(input, "text");

        projects.enqueue(project.coordinatorId, actor, {
          kind: "message",
          text: `[Thread "${member.title}" (${member.sessionId})] ${said}`,
          notice: {
            kind: "thread_message",
            data: {
              threadId: member.sessionId,
              title: member.title,
              text: said,
            },
          },
        });

        return "Message queued for the coordinator.";
      },
    ),
    tool(
      {
        name: "set_status",
        annotations: { destructiveHint: false },
        description: `Set this thread's work state: ${workStates.join(", ")}.`,
        parameters: object(
          {
            state: { type: "string", enum: [...workStates] },
            note: text("Optional: why, in one line"),
          },
          ["state"],
        ),
      },
      "thread",
      (input, { member, project, actor }) => {
        const state = workState(input["state"]);
        const note = optional(input, "note");
        projects.setWorkState(member.sessionId, state);

        projects.enqueue(project.coordinatorId, actor, {
          kind: "context",
          ...threadNotice(
            { ...member, workState: state },
            sessions.get(member.sessionId),
            `set its work state to ${state}${note === undefined ? "" : `: ${note.replace(/\.+$/, "")}`}`,
          ),
        });

        return `Work state set to ${state}.`;
      },
    ),
    tool(
      {
        name: "memory_list",
        annotations: { readOnlyHint: true },
        description:
          "List the Project's memory files with their size, last writer and time.",
        parameters: object({}, []),
      },
      "both",
      (_input, { project }) => {
        const files = projects.memory(project.id);

        return files.length === 0
          ? "Project memory is empty."
          : files
              .map(
                (file) =>
                  `${file.name} · ${String(file.size)} bytes · ${file.actor} · ${file.updatedAt}`,
              )
              .join("\n");
      },
    ),
    tool(
      {
        name: "memory_read",
        annotations: { readOnlyHint: true },
        description:
          "Read one Project memory file, with the revision memory_write needs to change it.",
        parameters: object({ name: text("File name, like MEMORY.md") }, [
          "name",
        ]),
      },
      "both",
      (input, { project }) => {
        const name = required(input, "name");
        const file = projects.readMemory(project.id, name);
        if (file === undefined) {
          throw new Error(`no memory file ${name}`);
        }

        return `${name}, revision ${String(file.revision)}:\n\n${file.content}`;
      },
    ),
    tool(
      {
        name: "memory_write",
        annotations: { destructiveHint: false },
        description:
          "Replace one Project memory file (16 KB at most). To change a file that exists, read it first and pass the revision memory_read gave; a write on top of an older revision is refused, so read again and redo your change. MEMORY.md is the index every new Project session gets in its system prompt.",
        parameters: object(
          {
            name: text("File name, like MEMORY.md or decisions.md"),
            content: text("The whole new content"),
            revision: {
              type: "integer",
              description:
                "The revision memory_read gave, for a file that exists",
            },
          },
          ["name", "content"],
        ),
      },
      "both",
      (input, { project, actor }) => {
        const name = required(input, "name");
        if (!/^[\w.-]+$/.test(name) || /^\.+$/.test(name)) {
          throw new Error("file names may use letters, digits, . _ and -");
        }

        const { revision } = input;

        projects.writeMemory(
          project.id,
          name,
          required(input, "content"),
          actor,
          typeof revision === "number" ? revision : undefined,
        );

        return `Wrote ${name}.`;
      },
    ),
  ];
}

function failure(message: string): ToolResult {
  return { text: message, isError: true };
}

function object(
  properties: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return { type: "object", properties, required: keys };
}

function text(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function required(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} is required`);
  }

  return value;
}

function optional(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];

  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function modelRef(name: string | undefined): ModelRef | undefined {
  if (name === undefined) {
    return undefined;
  }

  const slash = name.indexOf("/");
  if (slash <= 0 || slash === name.length - 1) {
    throw new Error("model must be provider/id");
  }

  return { provider: name.slice(0, slash), id: name.slice(slash + 1) };
}

export function workState(value: unknown): WorkState {
  const found = workStates.find((state) => state === value);
  if (found === undefined) {
    throw new Error(`state must be one of ${workStates.join(", ")}`);
  }

  return found;
}
