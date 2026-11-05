import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  activityStatus,
  actor,
  modelRef,
  session,
  thinkingLevel,
} from "./session";
import { nullable, strings, type Wire } from "./wire";

const questionOption = Type.Object({
  value: Type.String(),
  label: Type.String(),
  description: nullable(Type.String()),
  recommended: Type.Boolean(),
});

export type QuestionOption = Wire<typeof questionOption>;

const questionBase = {
  id: Type.String(),
  label: Type.String(),
  prompt: Type.String(),
  context: nullable(Type.String()),
};

export const question = Type.Union([
  Type.Object({
    ...questionBase,
    type: Type.Enum(["single", "multi", "scale", "rank"]),
    options: Type.Array(questionOption),
  }),
  Type.Object({
    ...questionBase,
    type: Type.Literal("text"),
    placeholder: nullable(Type.String()),
  }),
  Type.Object({
    ...questionBase,
    type: Type.Literal("number"),
    min: Type.Number(),
    max: Type.Number(),
    step: Type.Number(),
    unit: nullable(Type.String()),
    recommended: nullable(Type.Number()),
  }),
]);

export type Question = Wire<typeof question>;

const selection = Type.Object({
  value: Type.String(),
  label: Type.String(),
  custom: Type.Boolean(),
  annotation: nullable(Type.String()),
});

export type Selection = Wire<typeof selection>;

const questionAnswer = Type.Union([
  Type.Object({
    id: Type.String(),
    type: Type.Literal("choice"),
    selections: Type.Array(selection),
  }),
  Type.Object({
    id: Type.String(),
    type: Type.Literal("text"),
    text: Type.String(),
  }),
  Type.Object({
    id: Type.String(),
    type: Type.Literal("number"),
    value: Type.Number(),
  }),
]);

export type QuestionAnswer = Wire<typeof questionAnswer>;

const answered = Type.Object({
  answers: Type.Array(questionAnswer),
  note: nullable(Type.String()),
});

const questionsAnswer = Type.Object({
  ...answered.properties,
  // Who answered, in team work, which the server fills in (ADR 0065).
  by: Type.Optional(Type.String()),
});

export type QuestionsAnswer = Wire<typeof questionsAnswer>;

const answer = Type.Union([
  Type.String(),
  Type.Boolean(),
  questionsAnswer,
  Type.Null(),
]);

export type Answer = Wire<typeof answer>;

// One field of a tool call a permission prompt shows, such as a new name.
const permissionDetail = Type.Object({
  label: Type.String(),
  value: Type.String(),
});

export type PermissionDetail = Wire<typeof permissionDetail>;

// How the user answered a permission prompt: run the call, run every call of
// that tool for the rest of the Session, or don't run it.
export type Permission = "once" | "session" | "deny";

const prompt = Type.Union([
  Type.Object({
    id: Type.String(),
    kind: Type.Literal("questions"),
    title: Type.String(),
    questions: Type.Array(question),
    explain: Type.Boolean(),
    // In team work, the name of the person Pi asks (ADR 0065). Anyone who
    // steers may answer for them.
    for: Type.Optional(Type.String()),
  }),
  Type.Object({
    id: Type.String(),
    kind: Type.Literal("confirm"),
    title: Type.String(),
    message: Type.String(),
  }),
  Type.Object({
    id: Type.String(),
    kind: Type.Literal("permission"),
    title: Type.String(),
    details: Type.Array(permissionDetail),
  }),
  Type.Object({
    id: Type.String(),
    kind: Type.Literal("select"),
    title: Type.String(),
    options: strings,
  }),
  Type.Object({
    id: Type.String(),
    kind: Type.Enum(["input", "secret"]),
    title: Type.String(),
    placeholder: nullable(Type.String()),
  }),
  Type.Object({
    id: Type.String(),
    kind: Type.Literal("editor"),
    title: Type.String(),
    prefill: nullable(Type.String()),
  }),
]);

export type Prompt = Wire<typeof prompt>;

// What a meta-session's tool asks the browsers watching it to do (ADR 0035):
// open a route of the web app, such as a Session's id or plugin/projects/<id>.
const uiAction = Type.Object({
  kind: Type.Literal("open"),
  route: Type.String(),
  label: Type.String(),
});

export type UiAction = Wire<typeof uiAction>;

const terminalTab = Type.Object({ id: Type.String(), label: Type.String() });

export type TerminalTab = Wire<typeof terminalTab>;

const openedPage = Type.Object({ id: Type.String(), url: Type.String() });

export type OpenedPage = Wire<typeof openedPage>;

const slashCommand = Type.Object({
  name: Type.String(),
  description: nullable(Type.String()),
  source: Type.Enum(["builtin", "extension", "prompt", "skill"]),
});

export type SlashCommand = Wire<typeof slashCommand>;

const lines = nullable(strings);

const statusEvent = Type.Object({
  type: Type.Literal("status"),
  status: activityStatus,
  // On the idle status that ends a turn: how many transcript lines the
  // turn ended with, which the transcript upload may not have reached yet.
  transcriptLength: Type.Optional(Type.Integer({ minimum: 0 })),
});

const liveEvent = Type.Union([
  statusEvent,
  Type.Object({ type: Type.Literal("prompt"), prompt }),
  Type.Object({ type: Type.Literal("prompt_end"), id: Type.String() }),
  // The Session's shells that are still running (ADR 0026).
  Type.Object({
    type: Type.Literal("terminals"),
    terminals: Type.Array(terminalTab),
  }),
  // What the Session asked to open in a browser (ADR 0037).
  Type.Object({ type: Type.Literal("pages"), pages: Type.Array(openedPage) }),
  // Whether a browser shows Pi's TUI, which then takes the dialogs, and the
  // dialog open in it (ADR 0027).
  Type.Object({
    type: Type.Literal("pi_view"),
    attached: Type.Boolean(),
    dialog: nullable(Type.String()),
  }),
  Type.Object({
    type: Type.Literal("notify"),
    message: Type.String(),
    level: Type.Enum(["info", "warning", "error"]),
  }),
  Type.Object({
    type: Type.Literal("extension_status"),
    key: Type.String(),
    text: nullable(Type.String()),
  }),
  Type.Object({
    type: Type.Literal("widget"),
    key: Type.String(),
    lines,
    placement: Type.Enum(["aboveEditor", "belowEditor"]),
  }),
  // What an extension wrote for hosts in a text widget line
  // PI_<NAME>_JSON:<json>, or null once the widget is gone (ADR 0030).
  Type.Object({
    type: Type.Literal("extension_data"),
    key: Type.String(),
    name: Type.String(),
    data: Type.Unknown(),
  }),
  // An extension's footer, which replaces the statuses row, and header, as
  // rendered lines with their SGR escape codes (ADR 0029).
  Type.Object({ type: Type.Literal("footer"), lines }),
  Type.Object({ type: Type.Literal("header"), lines }),
  Type.Object({ type: Type.Literal("title"), title: Type.String() }),
  // What `/` can run, sent when an attempt starts (ADR 0006).
  Type.Object({
    type: Type.Literal("commands"),
    commands: Type.Array(slashCommand),
  }),
  // Workspace paths `@` can mention, at most 5,000 (ADR 0006).
  Type.Object({
    type: Type.Literal("files"),
    paths: strings,
    truncated: Type.Boolean(),
  }),
  Type.Object({
    type: Type.Literal("plugin"),
    plugin: Type.String(),
    key: Type.String(),
    data: Type.Unknown(),
    // The data holds something a person must answer, so the Session needs
    // them like a question does (ADR 0058).
    waiting: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    type: Type.Literal("queue"),
    steering: strings,
    followUp: strings,
  }),
  Type.Object({ type: Type.Literal("editor_text"), text: Type.String() }),
  // Sent by the server, never by a runner, and not replayed.
  Type.Object({ type: Type.Literal("ui_action"), action: uiAction }),
  // The Session's model and reasoning level, the levels its model takes
  // (ADR 0023), and the models it has credentials for (ADR 0024).
  Type.Object({
    type: Type.Literal("settings"),
    model: nullable(modelRef),
    thinking: thinkingLevel,
    levels: Type.Array(thinkingLevel),
    models: Type.Array(modelRef),
  }),
  // Pi's estimate of how much of the model's context the Session fills,
  // with no tokens while Pi can't tell, such as after a compaction (ADR 0038).
  Type.Object({
    type: Type.Literal("context"),
    tokens: nullable(Type.Number()),
    window: Type.Number(),
  }),
  Type.Object({
    type: Type.Literal("explanation"),
    id: Type.String(),
    questionId: Type.String(),
    value: Type.String(),
    question: nullable(Type.String()),
    text: nullable(Type.String()),
    error: nullable(Type.String()),
  }),
  Type.Object({ type: Type.Literal("text"), delta: Type.String() }),
  Type.Object({
    type: Type.Literal("tool_start"),
    toolCallId: Type.String(),
    toolName: Type.String(),
  }),
  Type.Object({
    type: Type.Literal("tool_end"),
    toolCallId: Type.String(),
    isError: Type.Boolean(),
  }),
]);

export type LiveEvent = Wire<typeof liveEvent>;

// What a runner may post. Only a status event changes the stored Session, so
// only it is checked; the rest pass through to browsers unchecked, so events
// from a newer runner still reach them. Only the server sends ui_action.
export const postedEvent = Type.Unsafe<LiveEvent>(
  Type.Refine(
    Type.Object({ type: Type.String() }, { additionalProperties: true }),
    (event) =>
      event.type !== "ui_action" &&
      (event.type !== "status" || Value.Check(statusEvent, event)),
    (event) =>
      event.type === "ui_action"
        ? "can't be ui_action: only the server sends it"
        : "must be a status of idle or running, with a transcriptLength of 0 or more",
  ),
);

// The part of a Session's live state an event sets. A later event with the
// same key replaces it, and a closed surface is no longer shown.
export function liveSurface(
  event: LiveEvent,
): { readonly key: string; readonly open: boolean } | undefined {
  switch (event.type) {
    case "prompt":
      return { key: `prompt:${event.prompt.id}`, open: true };
    case "prompt_end":
      return { key: `prompt:${event.id}`, open: false };
    case "extension_status":
      return { key: `status:${event.key}`, open: event.text !== null };
    case "widget":
      return { key: `widget:${event.key}`, open: event.lines !== null };
    case "extension_data":
      return { key: `data:${event.key}`, open: event.data !== null };
    case "footer":
    case "header":
      return { key: event.type, open: event.lines !== null };
    case "title":
      return { key: "title", open: true };
    case "commands":
      return { key: "commands", open: true };
    case "files":
      return { key: "files", open: true };
    case "terminals":
      return { key: "terminals", open: event.terminals.length > 0 };
    case "pages":
      return { key: "pages", open: event.pages.length > 0 };
    case "pi_view":
      return { key: "pi_view", open: event.attached || event.dialog !== null };
    case "settings":
      return { key: "settings", open: true };
    case "context":
      return { key: "context", open: true };
    case "plugin":
      return { key: `plugin:${event.plugin}:${event.key}`, open: true };
    case "queue":
      return {
        key: "queue",
        open: event.steering.length > 0 || event.followUp.length > 0,
      };
    case "status":
    case "notify":
    case "editor_text":
    case "ui_action":
    case "explanation":
    case "text":
    case "tool_start":
    case "tool_end":
      return undefined;
  }
}

export const toolResult = Type.Object({
  text: Type.String(),
  isError: Type.Boolean(),
  // What the tool opened, kept in its result so the chat can draw a card
  // for it after a reload (ADR 0052).
  opened: Type.Optional(uiAction),
});

export type ToolResult = Wire<typeof toolResult>;

export const imageTypes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export const imageLimits = { count: 5, bytes: 5 * 1024 * 1024 } as const;

// Base64 image data sent to the model with a message (ADR 0006).
const imageAttachment = Type.Object({
  mimeType: Type.Enum(imageTypes),
  data: Type.Refine(
    Type.String({ pattern: "^[A-Za-z0-9+/]*={0,2}$" }),
    (data) => Buffer.byteLength(data, "base64") <= imageLimits.bytes,
    () =>
      `must be at most ${String(imageLimits.bytes / 1024 / 1024)} MB of base64`,
  ),
});

export type ImageAttachment = Wire<typeof imageAttachment>;

// The custom message type that carries a NoticeTag in its details.
export const noticeType = "pipoca-notice";

const noticeTag = Type.Object({
  plugin: Type.String(),
  kind: Type.String(),
  data: Type.Optional(Type.Unknown()),
});

export type NoticeTag = Wire<typeof noticeTag>;

const delivery = Type.Enum(["steer", "followUp"]);

// What a browser may send a Session. Terminal and preview commands come from
// the server's own sockets and previews, never from a browser's POST.
const browserCommands = [
  Type.Object({
    type: Type.Literal("message"),
    text: Type.String(),
    images: Type.Optional(
      Type.Array(imageAttachment, { maxItems: imageLimits.count }),
    ),
    requestId: Type.Optional(Type.String()),
    delivery: Type.Optional(delivery),
  }),
  Type.Object({ type: Type.Literal("abort") }),
  Type.Object({ type: Type.Literal("set_model"), model: modelRef }),
  Type.Object({ type: Type.Literal("set_thinking"), level: thinkingLevel }),
  // How many columns the web has for extensions' widgets, footer and header
  // (ADR 0029).
  Type.Object({
    type: Type.Literal("ui_columns"),
    columns: Type.Integer({ minimum: 1, maximum: 1000 }),
  }),
  // Takes a queued message back before Pi reads it; the text returns to the
  // composer as editor_text. With sendNow it moves to the steering queue
  // instead, so Pi reads it after its current step.
  Type.Object({
    type: Type.Literal("unqueue"),
    delivery,
    text: Type.String(),
    sendNow: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    type: Type.Literal("explain"),
    id: Type.String(),
    questionId: Type.String(),
    value: Type.String(),
    question: nullable(Type.String()),
  }),
  Type.Object({ type: Type.Literal("close_page"), id: Type.String() }),
] as const;

// The message a reply answers (ADR 0065), as it read then. Pi's own are
// from "pi".
export const quote = Type.Object({ from: Type.String(), text: Type.String() });

export type Quote = Wire<typeof quote>;

export const browserCommand = Type.Intersect([
  Type.Union([
    ...browserCommands,
    Type.Object({
      type: Type.Literal("answer"),
      id: Type.String(),
      value: Type.Union([Type.String(), Type.Boolean(), answered, Type.Null()]),
    }),
  ]),
  Type.Object({ quote: Type.Optional(quote) }),
]);

export const command = Type.Intersect([
  Type.Object({ actor }),
  Type.Union([
    ...browserCommands,
    Type.Object({
      type: Type.Literal("answer"),
      id: Type.String(),
      value: answer,
    }),
    // Context for the model's next turn that doesn't start one. Hidden, it
    // stays out of the chat, such as what the team said before a message.
    Type.Object({
      type: Type.Literal("context"),
      text: Type.String(),
      hidden: Type.Optional(Type.Boolean()),
    }),
    // A plugin's notice to the model, which the web draws with the plugin's
    // own renderer (ADR 0028). With turn it starts a turn, or waits as a
    // follow-up while one runs.
    Type.Object({
      type: Type.Literal("notice"),
      text: Type.String(),
      notice: noticeTag,
      turn: Type.Boolean(),
    }),
    Type.Object({
      type: Type.Literal("tool_result"),
      id: Type.String(),
      result: toolResult,
    }),
    Type.Object({
      type: Type.Literal("terminal"),
      terminalId: Type.String(),
      cols: Type.Number(),
      rows: Type.Number(),
    }),
    // A browser's request to a preview, which the Session host picks up on
    // its own socket (ADR 0037).
    Type.Object({
      type: Type.Literal("preview"),
      connectionId: Type.String(),
      port: Type.Number(),
    }),
  ]),
]);

export type Command = Wire<typeof command>;

// The terminal id that opens Pi's own TUI instead of a shell (ADR 0027).
export const piTerminal = "pi";

// The close reason a terminal socket gets when another browser opens the same
// terminal. Reopening it then would only take it back.
export const terminalTakenOver = "opened elsewhere";

const terminalResize = Type.Object({
  type: Type.Literal("resize"),
  cols: Type.Number(),
  rows: Type.Number(),
});

export type TerminalResize = Wire<typeof terminalResize>;

// The text frames a browser sends on a terminal socket. Closing the socket
// leaves the shell running; a close frame ends it (ADR 0026).
export const terminalControl = Type.Union([
  terminalResize,
  Type.Object({ type: Type.Literal("close") }),
]);

export type TerminalControl = Wire<typeof terminalControl>;

// The port of a page on the Session's own machine, which only a preview
// reaches.
export function previewPort(url: string): number | undefined {
  if (!URL.canParse(url)) {
    return undefined;
  }

  const { protocol, hostname, port } = new URL(url);
  if (protocol !== "http:" || !loopbackNames.has(hostname)) {
    return undefined;
  }

  return port === "" ? 80 : Number(port);
}

const loopbackNames = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

const headers = Type.Array(Type.Tuple([Type.String(), Type.String()]));

// A browser's request as the server sends it to the Session host over a
// preview socket. The body follows as one binary frame. A WebSocket's frames
// follow its answer's head instead, both ways.
export const previewRequest = Type.Object({
  method: Type.String(),
  path: Type.String(),
  headers,
  websocket: Type.Optional(Type.Boolean()),
});

export type PreviewRequest = Wire<typeof previewRequest>;

// The answer's head, which the Session host sends first. Binary frames with
// the body follow, and a normal close ends it.
export const previewResponse = Type.Object({ status: Type.Number(), headers });

export type PreviewResponse = Wire<typeof previewResponse>;

// What a person said in a team Session (ADR 0054, ADR 0065), which Pi's
// transcript doesn't keep: a message to Pi, a stop, a message to the team
// that Pi reads only when next asked, or one off the record that Pi never
// reads. A vote's result is told by whoever opened it, a person's id or "pi".
const voice = Type.Object({
  kind: Type.Enum(["message", "stop", "team", "aside", "vote"]),
  person: Type.String(),
  at: Type.String(),
  text: Type.Optional(Type.String()),
  quote: Type.Optional(quote),
});

export type Voice = Wire<typeof voice>;

// Pi reads at most this many of the team's messages since its last turn,
// and past it the Session offers a fork (ADR 0065).
export const teamMessagesRead = 40;

// What the team said since the last message to Pi, which Pi reads with the
// next one.
export function teamTalkSince(voices: readonly Voice[]): readonly Voice[] {
  const since = voices.findLastIndex(({ kind }) => kind === "message");

  return voices
    .slice(since + 1)
    .filter(({ kind }) => kind === "team" || kind === "vote");
}

// Someone looking at a team Session, and whether they are typing in it.
export const presence = Type.Object({
  person: Type.String(),
  typing: Type.Boolean(),
});

export type Presence = Wire<typeof presence>;

export const sessionEvent = Type.Union([
  Type.Object({
    type: Type.Literal("entry"),
    line: Type.Integer(),
    entry: Type.String(),
  }),
  Type.Object({ type: Type.Literal("voice"), voice }),
  Type.Object({ type: Type.Literal("live"), event: liveEvent }),
  Type.Object({ type: Type.Literal("session"), session }),
]);

export type SessionEvent = Wire<typeof sessionEvent>;
