import {
  type ServerContext,
  type Session,
  StringEnum,
  ToolError,
  Type,
  type When,
} from "@pipoca/plugins";
import type { Actor, ModelRef } from "@pipoca/protocol";
import type { projects } from "../plugin";
import { type Role, workStates } from "./model";
import { threadNotice, threadPrompt, threadView, unreachable } from "./prompts";
import type { Member, Project, ProjectStore } from "./store";

const pageSize = 20;

type Context = ServerContext<typeof projects>;

interface Caller {
  readonly member: Member;
  readonly project: Project;
  readonly actor: Actor;
}

// The tools a coordinator and its threads work with (ADR 0016), each only in
// the Sessions of its role.
export function projectTools(context: Context, store: ProjectStore): void {
  const { sessions, tools, transcript } = context;

  const callerOf = (session: Session): Caller => {
    const member = store.member(session.id);
    const project = member && store.get(member.projectId);

    if (member === undefined || project === undefined) {
      throw new ToolError("this session is not in a Project");
    }

    return { member, project, actor: `session:${session.id}` };
  };

  const only = (role: Exclude<Role, "former"> | "both"): When => ({
    ownSessions: true,
    available: (session) => {
      const member = store.member(session.id);

      return member !== undefined && (role === "both" || member.role === role);
    },
  });

  const threadOf = (project: Project, id: string): Member => {
    const thread = store.member(id);

    if (thread?.projectId !== project.id || thread.role !== "thread") {
      throw new ToolError(`no thread ${id} in this Project`);
    }

    return thread;
  };

  const brief = (threadId: string, actor: Actor, text: string): void => {
    sessions.send(threadId, {
      text,
      turn: true,
      as: actor,
      notice: { kind: "coordinator_message", data: { text } },
    });
  };

  tools.define({
    when: only("coordinator"),
    name: "start_thread",
    annotations: { destructive: false },
    description:
      "Start a thread: a new Pi session with its own checkout of the Project's repositories, which works on one task and reports back.",
    params: Type.Object({
      title: Type.String({
        minLength: 1,
        description: "A short name for the thread's task",
      }),
      message: Type.String({
        minLength: 1,
        description:
          'Your brief for the thread, addressed to it: the task, what done looks like, and only the facts it needs, such as decisions the user made. Write it as an instruction ("Build…"), never as a report about the user ("User wants…")',
      }),
      repositories: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Repository URLs to check out, a subset of the Project's. Default: all of them.",
        }),
      ),
      start_points: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description:
            "Branch, tag or commit to start each repository's branch from, keyed by repository URL. Default: the repository's default branch.",
        }),
      ),
      environment: Type.Optional(
        Type.String({ description: "Environment id to run in. Default: the Project's" }),
      ),
      profile: Type.Optional(
        Type.String({
          description:
            "Profile id to run with. Default: the Project's, else the user's default",
        }),
      ),
      model: Type.Optional(
        Type.String({ description: "Model as provider/id. Default: the coordinator's" }),
      ),
    }),
    run: (input, { session }) => {
      const { project, actor } = callerOf(session);
      const repositories =
        input.repositories === undefined
          ? project.repositories
          : [...new Set(input.repositories)];

      const unknown = repositories.filter(
        (url) => !project.repositories.includes(url),
      );

      if (
        unknown.length > 0 ||
        (repositories.length === 0 && project.assistantOf === null)
      ) {
        throw new ToolError(
          `repositories must be some of: ${project.repositories.join(", ")}`,
        );
      }

      const environment =
        nonEmpty(input.environment) ?? project.environmentId ?? undefined;

      const profile = nonEmpty(input.profile) ?? project.profileId ?? undefined;

      const model =
        modelRef(nonEmpty(input.model)) ??
        modelRef(project.threadModel ?? undefined) ??
        sessions.get(project.coordinatorId)?.model ??
        undefined;

      const thread = sessions.start({
        actor,
        key: project.id,
        ...(project.owner === "team" && { team: true }),
        ...(environment !== undefined && { environment }),
        ...(profile !== undefined && { profile }),
        workspace: {
          kind: "repositories",
          repositories: repositories.map((repository) => {
            const startPoint = input.start_points?.[repository];

            return startPoint === undefined || startPoint === ""
              ? { repository }
              : { repository, startPoint };
          }),
        },
        ...(model && { model }),
        systemPrompt: threadPrompt(
          project,
          input.title,
          store.readMemory(project.id, "MEMORY.md")?.content,
        ),
      });

      store.addThread(project.id, thread.id, input.title);

      // The brief is the coordinator's, so the thread's chat shows it as
      // such, not as the person's message.
      brief(thread.id, actor, input.message);

      return `Started thread "${input.title}" as ${thread.id}.`;
    },
  });

  tools.define({
    when: only("coordinator"),
    name: "message_thread",
    annotations: { destructive: false },
    description:
      "Send a message to a thread. It starts a turn, or waits as a follow-up if the thread is busy.",
    params: Type.Object({
      thread: Type.String({ description: "The thread's id" }),
      text: Type.String({ minLength: 1, description: "The message" }),
    }),
    run: (input, { session }) => {
      const { project, actor } = callerOf(session);
      const thread = threadOf(project, input.thread);

      const refused = unreachable(
        `thread "${thread.title}"`,
        sessions.get(thread.sessionId),
      );

      if (refused !== undefined) {
        throw new ToolError(refused);
      }

      brief(thread.sessionId, actor, input.text);

      return `Message queued for thread "${thread.title}".`;
    },
  });

  tools.define({
    when: only("coordinator"),
    name: "list_threads",
    annotations: { readOnly: true },
    description:
      "List the Project's threads with their title, run state, work state, Environment, branch and last activity.",
    params: Type.Object({}),
    run: (_input, { session }) => {
      const { project } = callerOf(session);
      const threads = store.threads(project.id);

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
  });

  tools.define({
    when: only("coordinator"),
    name: "read_thread",
    annotations: { readOnly: true },
    description: `Read a thread's messages, newest first, ${String(pageSize)} per page.`,
    params: Type.Object({
      thread: Type.String({ description: "The thread's id" }),
      page: Type.Optional(
        Type.Integer({ minimum: 1, description: "Page number, from 1" }),
      ),
    }),
    run: (input, { session }) => {
      const { project } = callerOf(session);
      const thread = threadOf(project, input.thread);
      const page = input.page ?? 1;
      const messages = transcript.messages(thread.sessionId);
      const end = messages.length - (page - 1) * pageSize;

      const shown =
        end > 0 ? messages.slice(Math.max(0, end - pageSize), end) : [];

      if (shown.length === 0) {
        return `Thread "${thread.title}" has no messages on page ${String(page)}.`;
      }

      return [
        `Thread "${thread.title}", page ${String(page)} of ${String(Math.ceil(messages.length / pageSize))}, oldest first:`,
        ...shown.map(({ role, text }) => `[${role}] ${text}`),
      ].join("\n\n");
    },
  });

  tools.define({
    when: only("thread"),
    name: "message_coordinator",
    annotations: { destructive: false },
    description:
      "Send a message to the Project's coordinator. It starts a coordinator turn, so use it for decisions and results, not progress.",
    params: Type.Object({
      text: Type.String({ minLength: 1, description: "The message" }),
    }),
    run: (input, { session }) => {
      const { member, project, actor } = callerOf(session);
      sessions.send(project.coordinatorId, {
        text: `[Thread "${member.title}" (${member.sessionId})] ${input.text}`,
        turn: true,
        as: actor,
        notice: {
          kind: "thread_message",
          data: {
            threadId: member.sessionId,
            title: member.title,
            text: input.text,
          },
        },
      });

      return "Message queued for the coordinator.";
    },
  });

  tools.define({
    when: only("thread"),
    name: "set_status",
    annotations: { destructive: false },
    description: `Set this thread's work state: ${workStates.join(", ")}.`,
    params: Type.Object({
      state: StringEnum(workStates),
      note: Type.Optional(
        Type.String({ description: "Optional: why, in one line" }),
      ),
    }),
    run: (input, { session }) => {
      const { member, project, actor } = callerOf(session);
      store.setWorkState(member.sessionId, input.state);

      const note = nonEmpty(input.note);

      const { text, notice } = threadNotice(
        { ...member, workState: input.state },
        sessions.get(member.sessionId),
        `set its work state to ${input.state}${note === undefined ? "" : `: ${note.replace(/\.+$/, "")}`}`,
      );

      sessions.send(project.coordinatorId, {
        text,
        turn: false,
        as: actor,
        notice,
      });

      context.routes.topic("projects");

      return `Work state set to ${input.state}.`;
    },
  });

  tools.define({
    when: only("both"),
    name: "memory_list",
    annotations: { readOnly: true },
    description:
      "List the Project's memory files with their size, last writer and time.",
    params: Type.Object({}),
    run: (_input, { session }) => {
      const { project } = callerOf(session);
      const files = store.memory(project.id);

      return files.length === 0
        ? "Project memory is empty."
        : files
            .map(
              (file) =>
                `${file.name} · ${String(file.size)} bytes · ${file.actor} · ${file.updatedAt}`,
            )
            .join("\n");
    },
  });

  tools.define({
    when: only("both"),
    name: "memory_read",
    annotations: { readOnly: true },
    description:
      "Read one Project memory file, with the revision memory_write needs to change it.",
    params: Type.Object({
      name: Type.String({ description: "File name, like MEMORY.md" }),
    }),
    run: (input, { session }) => {
      const { project } = callerOf(session);
      const file = store.readMemory(project.id, input.name);

      if (file === undefined) {
        throw new ToolError(`no memory file ${input.name}`);
      }

      return `${input.name}, revision ${String(file.revision)}:\n\n${file.content}`;
    },
  });

  tools.define({
    when: only("both"),
    name: "memory_write",
    annotations: { destructive: false },
    description:
      "Replace one Project memory file (16 KB at most). To change a file that exists, read it first and pass the revision memory_read gave; a write on top of an older revision is refused, so read again and redo your change. MEMORY.md is the index every new Project session gets in its system prompt.",
    params: Type.Object({
      name: Type.String({
        description: "File name, like MEMORY.md or decisions.md",
      }),
      content: Type.String({ description: "The whole new content" }),
      revision: Type.Optional(
        Type.Integer({
          description: "The revision memory_read gave, for a file that exists",
        }),
      ),
    }),
    run: (input, { session }) => {
      const { project, actor } = callerOf(session);
      if (!/^[\w.-]+$/.test(input.name) || /^\.+$/.test(input.name)) {
        throw new ToolError("file names may use letters, digits, . _ and -");
      }

      try {
        store.writeMemory(
          project.id,
          input.name,
          input.content,
          actor,
          input.revision,
        );
      } catch (error) {
        throw new ToolError(error instanceof Error ? error.message : String(error));
      }

      context.routes.topic("projects");

      return `Wrote ${input.name}.`;
    },
  });
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

export function modelRef(name: string | undefined): ModelRef | undefined {
  if (name === undefined) {
    return undefined;
  }

  const slash = name.indexOf("/");

  if (slash <= 0 || slash === name.length - 1) {
    throw new ToolError("model must be provider/id");
  }

  return { provider: name.slice(0, slash), id: name.slice(slash + 1) };
}
