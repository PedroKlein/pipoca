import type { Session } from "@pipoca/protocol";
import type { ProjectNotice, RunState, ThreadView } from "./model";
import type { Member, Project } from "./store";

// What a fresh coordinator needs from the one it replaces: Pi's latest
// compaction summary and the chat since.
interface RecentChat {
  readonly summary: string | undefined;
  readonly messages: readonly {
    readonly role: string;
    readonly text: string;
  }[];
}

// Enough to tell what a thread did; the rest stays in the thread, which the
// coordinator reads with read_thread when it needs to.
const replyLimit = 300;
const handoffLimit = 12_000;

type Draft = Omit<Project, "coordinatorId" | "createdAt">;

export function coordinatorPrompt(
  project: Draft,
  memoryIndex: string | undefined,
): string {
  return [
    ...(project.assistantOf !== null
      ? [
          "You are the person's Pipoca assistant, as the coordinator of their assistant Project.",
          "Answer questions and do one-shot actions yourself with your Pipoca tools, such as starting a Session for the person's own goal, creating a Project or renaming something. Start a thread with start_thread for work the person will iterate on, such as building a Profile, a plugin or an Environment's setup. A thread is a full Pi session with a shell in a workspace of its own, possibly on another machine, with your Pipoca tools too.",
        ]
      : [
          `You are the coordinator of the Pipoca Project "${project.name}".`,
          "You plan the work and hand it to threads. A thread is a full Pi session with its own checkout of the Project's repositories on its own branch, possibly on another machine. Start one with start_thread for each separate piece of work, with a clear first message. Do small reads and answers yourself.",
        ]),
    "After each thread turn its notice reaches you as context, without a turn: its state and the start of its reply. Threads exist to keep their detail out of your conversation, and the user talks to a thread in the thread, so don't repeat a thread's work to the user. A thread that needs you messages you, and that gives you a turn; so does a thread that stops or fails. Then read what you need with read_thread. Don't poll or sleep while threads work. Use list_threads to see every thread's state and message_thread to tell a thread something. Don't message a thread only to acknowledge it.",
    "Size the work to what the user asked. Hand a thread the user's ask with the scope they gave it, and don't widen it: when they want to discuss something, the thread starts by talking with them, not by auditing everything first. Say what the thread should do rather than listing what it must not do. Questions and decisions about a thread's work belong in that thread.",
    "Share files through the Project's shared folder, never a path inside one Session: other Sessions can't read it.",
    "The user can talk to any thread directly. Treat what a thread reports as the current state.",
    "When you mention a thread in a reply, link it as [its title](thread:<thread id>): the user sees a chip with its live state that opens it.",
    "Keep facts that must outlast this conversation in Project memory with memory_write. MEMORY.md is its index: keep it short, one line per file or fact.",
    ...projectContext(project, memoryIndex),
  ].join("\n\n");
}

export function threadPrompt(
  project: Project,
  title: string,
  memoryIndex: string | undefined,
): string {
  return [
    project.assistantOf !== null
      ? `You are a thread of the person's Pipoca assistant, working on: ${title}.`
      : `You are a thread of the Pipoca Project "${project.name}", working on: ${title}.`,
    project.assistantOf !== null
      ? "Your working directory starts empty: clone the repositories you need into it with git, which is signed in to the person's git hosts."
      : "Your working directory holds each of the Project's repositories in its own folder, all on your branch.",
    "The user talks with you here, in the thread. Ask them your questions here, not through the coordinator.",
    "Size the work to what the user asked. When they want to discuss something, take a quick look, share a short view and ask what they want before doing more. Read only what the next step needs, start subagents only for heavy work that splits into independent parts, and when a tool keeps failing, stop after two tries and tell the user.",
    "Use message_coordinator when you need a decision or have a result the coordinator must act on, such as finished work. Don't use it for progress updates or to acknowledge the coordinator's messages: the coordinator sees a notice with your reply after each of your turns, without being woken.",
    "End every turn with a short reply that states your result. Mention what you changed only when you changed something; don't close replies with what you didn't do.",
    "Put the decisions you need now in one ask_user call, with a question each. Once the user approves a direction, carry it through without asking again at each step.",
    "Share files with the coordinator and other threads through the Project's shared folder, never a path inside this Session: they can't read it.",
    "Keep your work state current with set_status: in_progress, blocked, review_ready, done or failed.",
    "Project memory is shared with the coordinator and the other threads: memory_list, memory_read and memory_write.",
    ...projectContext(project, memoryIndex),
  ].join("\n\n");
}

function projectContext(
  project: Draft,
  memoryIndex: string | undefined,
): string[] {
  return [
    ...(project.repositories.length === 0
      ? []
      : [`Repositories: ${project.repositories.join(", ")}`]),
    ...(project.goal === "" ? [] : [`## Project goal\n\n${project.goal}`]),
    ...(project.instructions.trim() === ""
      ? []
      : [`## Project instructions\n\n${project.instructions.trim()}`]),
    ...(memoryIndex === undefined || memoryIndex.trim() === ""
      ? []
      : [`## Project memory (MEMORY.md)\n\n${memoryIndex.trim()}`]),
  ];
}

export function runState(session: Session | undefined): RunState {
  if (session?.archivedAt !== null) {
    return "archived";
  }

  if (!session.online) {
    return "offline";
  }

  if (session.waiting) {
    return "waiting";
  }

  switch (session.status) {
    case "idle":
      return "idle";
    case "interrupted":
    case "failed":
    case "stopped":
      return "interrupted";
    case "queued":
    case "starting":
    case "running":
      return "working";
  }
}

// A message waits only for a Session that will take it: a failed start never
// comes back, and ADR 0006 refuses input while the provider is offline.
export function unreachable(
  name: string,
  session: Session | undefined,
): string | undefined {
  if (session?.status === "failed") {
    return `${name} failed to start: ${session.error ?? "no error was given"}`;
  }

  switch (runState(session)) {
    case "archived":
      return `${name} is archived`;
    case "offline":
      return `${name} is on a machine that is offline`;
    case "working":
    case "waiting":
    case "idle":
    case "interrupted":
      return undefined;
  }
}

export function threadView(
  thread: Member,
  session: Session | undefined,
): ThreadView {
  const workspace = session?.workspace;

  return {
    sessionId: thread.sessionId,
    title: thread.title,
    runState: runState(session),
    workState: thread.workState,
    environmentId: session?.environmentId ?? "",
    branch: workspace && "branch" in workspace ? workspace.branch : null,
    lastActivity: new Date(thread.lastActivity).toISOString(),
  };
}

export function threadNotice(
  thread: Member,
  session: Session | undefined,
  event: string,
  reply?: string,
): { readonly text: string; readonly notice: ProjectNotice } {
  const state = runState(session);

  const shortReply =
    reply === undefined || reply.length <= replyLimit
      ? reply
      : `${reply.slice(0, replyLimit)}…`;

  return {
    text: [
      `[Project notice] Thread "${thread.title}" (${thread.sessionId}) ${event}. Run state: ${state}. Work state: ${thread.workState}.`,
      ...(shortReply === undefined ? [] : [`Its last reply: ${shortReply}`]),
    ].join("\n"),
    notice: {
      kind: "thread",
      data: {
        threadId: thread.sessionId,
        title: thread.title,
        event,
        runState: state,
        workState: thread.workState,
        ...(shortReply !== undefined && { reply: shortReply }),
      },
    },
  };
}

// What a coordinator that replaces another knows of the conversation.
// The newest chat matters most, so older messages go first when it is long.
export function handoffText(
  chat: RecentChat,
  threads: readonly ThreadView[],
): string {
  const lines = chat.messages.map(
    ({ role, text }) =>
      `${role === "user" ? "User" : "Coordinator"}: ${text.length <= replyLimit ? text : `${text.slice(0, replyLimit)}…`}`,
  );

  const kept: string[] = [];
  let size = 0;

  for (const line of lines.toReversed()) {
    size += line.length;
    if (size > handoffLimit && kept.length > 0) {
      break;
    }

    kept.unshift(line);
  }

  return [
    "## Handoff\n\nYou take over this Project from an earlier coordinator, whose context was full or whom the user replaced. Carry on from where it stopped, without greeting or summarising this handoff.",
    ...(chat.summary === undefined
      ? []
      : [`### Summary of the earlier conversation\n\n${chat.summary}`]),
    ...(kept.length === 0
      ? []
      : [`### The latest messages\n\n${kept.join("\n\n")}`]),
    `### Threads\n\n${
      threads.length === 0
        ? "None yet."
        : threads
            .map(
              (thread) =>
                `- ${thread.title} (${thread.sessionId}): ${thread.runState}, ${thread.workState}`,
            )
            .join("\n")
    }`,
  ].join("\n\n");
}
