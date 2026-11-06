import type {
  Environment,
  EnvironmentTemplate,
  PluginSettings,
  RepositoryChoice,
  Session,
  SessionEvent,
} from "@pipoca/protocol";
import {
  type ComponentType,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useState,
} from "react";
import { responseOrder } from "./responses";
import { topicOf, useScope } from "./shell";

export {
  type ModelOption,
  modelOptions,
  rememberModel,
  shownModels,
} from "./models";
export { responseOrder } from "./responses";
export { CollectionEditor, ConfigForm } from "./config-form";
export {
  defineWeb,
  Hidden,
  Slot,
  type Slots,
  useApi,
  useConfig,
  useSessionState,
  useToolResults,
  useTopic,
  useViewer,
  type WebPage,
  type WebPart,
} from "./parts";

// The shell's own Session view, for a plugin page to show a Session in
// (ADR 0028). A side view is a narrow panel next to the page's main view.
export interface EmbeddedSessionProps {
  readonly sessionId: string;
  readonly layout: "full" | "side";
  // Replaces the Session's own title in the header.
  readonly title?: string;
  // Shown before the title, such as a link back to the page.
  readonly crumb?: ReactNode;
  // Buttons at the end of the header.
  readonly actions?: ReactNode;
}

export type SettingsGroup = "you" | "workspace" | "server" | "integrations";

export interface WebContext {
  // A fetch of the plugin's own routes under /api/ext/<name>/, or of the
  // server's, such as /api/sessions, for a path that starts with /.
  readonly request: (path: string, init?: RequestInit) => Promise<Response>;
  readonly openSession: (sessionId: string) => void;
  // The link to a path inside the plugin's own page.
  readonly href: (path: string) => string;
  // The plugin's settings when the page loaded (ADR 0036).
  readonly settings: PluginSettings;
  readonly SessionView: ComponentType<EmbeddedSessionProps>;
}

export interface MountedSession {
  readonly id: string;
  // Every event the Session view receives, from the start of its stream.
  readonly events: (listener: (event: SessionEvent) => void) => () => void;
  // Sends a message as the user, such as one of the plugin's Pi commands.
  readonly send: (text: string) => Promise<void>;
}

export interface PageProps {
  readonly context: WebContext;
  // The rest of the address after the plugin's page, "" on the page itself.
  readonly path: string;
}

// The home screen, at the root of the app (ADR 0035).
export interface HomeProps {
  readonly context: WebContext;
  readonly onNewSession: () => void;
}

// A step of the first-run setup that a plugin owns, such as connecting a
// model (ADR 0063). done says whether the person already did it, and reloads
// when one of its topics changes. A step that isn't done stays on home as a
// reminder.
export interface SetupStep {
  // A few words in the list of steps, such as "A model".
  readonly title: string;
  readonly summary: string;
  // The step's page, such as "Connect a model".
  readonly heading: string;
  readonly description: string;
  readonly optional?: boolean;
  // Gives the step's page more room, such as for a grid of providers.
  readonly wide?: boolean;
  readonly done: (context: WebContext) => Promise<boolean>;
  readonly topics?: readonly string[];
  readonly Step: ComponentType<{ readonly context: WebContext }>;
}

export interface NavItemsProps {
  readonly context: WebContext;
  // The open path inside the plugin's page, undefined when it isn't open.
  readonly path: string | undefined;
}

// A notice the plugin sent a Session, drawn in its chat (ADR 0028).
export interface NoticeProps {
  readonly context: WebContext;
  readonly text: string;
  readonly data: unknown;
}

// A link of the plugin's own scheme in a chat answer, as [label](scheme:target).
export interface LinkProps {
  readonly context: WebContext;
  readonly target: string;
  readonly label: string;
}

export interface SessionPartProps {
  readonly context: WebContext;
  readonly session: MountedSession;
}

export interface EnvironmentSectionProps {
  readonly context: WebContext;
  readonly environment: Environment;
}

export interface TemplateSectionProps {
  readonly context: WebContext;
  readonly template: EnvironmentTemplate;
}

// A tool call a plugin draws in the chat, from the transcript (ADR 0030).
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
  readonly status: "running" | "done" | "failed";
  readonly result?: {
    readonly text: string;
    readonly details: unknown;
    readonly failed: boolean;
  };
}

export interface ToolCallProps extends SessionPartProps {
  readonly call: ToolCall;
}

export interface WidgetProps extends SessionPartProps {
  // The widget's lines as Pi's TUI renders them, with SGR escape codes.
  readonly lines: readonly string[];
}

// A card on a team hub page, which admins place by "<plugin>/<key>"
// (ADR 0067).
export interface HubPanel {
  readonly title: string;
  readonly Panel: ComponentType<{ readonly context: WebContext }>;
}

// A screen of its own in the team hub's menu.
export interface HubScreen {
  readonly label: string;
  readonly Page: ComponentType<{ readonly context: WebContext }>;
}

// A screen of Team setup, which only admins open, listed with what team work
// runs on or with its rules.
export interface SetupScreen extends HubScreen {
  readonly group: "runs-on" | "rules";
}

// Each slot is a React component rendered by the web app (ADR 0015).
export interface WebPlugin {
  readonly name: string;
  readonly nav?: {
    readonly label: string;
    readonly Page: ComponentType<PageProps>;
    // Links listed under the entry in the sidebar, such as each Project.
    readonly Items?: ComponentType<NavItemsProps>;
    // Paths whose page fills the window, such as an open Project, instead of
    // scrolling in the shell's column.
    readonly fills?: (path: string) => boolean;
    // Pinned in the sidebar for someone who never changed their pins.
    readonly pinned?: boolean;
  };
  // What the plugin gives the team hub, by key (ADR 0067).
  readonly hub?: {
    readonly panels?: Readonly<Record<string, HubPanel>>;
    readonly pages?: Readonly<Record<string, HubScreen>>;
    readonly setup?: Readonly<Record<string, SetupScreen>>;
  };
  // The first enabled plugin with a home screen draws the app's root.
  readonly Home?: ComponentType<HomeProps>;
  // Where a Session this plugin owns opens, as a path in its page. Links,
  // search results and notices for it go there (ADR 0028).
  readonly sessionPath?: (session: Session) => string;
  // Renderers for the plugin's notices in a chat, by kind.
  readonly notices?: Readonly<Record<string, ComponentType<NoticeProps>>>;
  // Renderers for links in chat answers, by URL scheme.
  readonly links?: Readonly<Record<string, ComponentType<LinkProps>>>;
  readonly SessionPanel?: ComponentType<SessionPartProps>;
  // A section on the Environments page for the open Environment, such as the
  // plugin's settings for it (ADR 0032).
  readonly EnvironmentSection?: ComponentType<EnvironmentSectionProps>;
  // A section in an Environment template, such as where the runners of
  // Environments made from it come from (ADR 0049).
  readonly TemplateSection?: ComponentType<TemplateSectionProps>;
  // The plugin's own page in Settings, listed in settingsGroup ("you" unless
  // it says otherwise). "integrations" makes it a tab of the Integrations
  // page, and "server" shows it to admins only (ADR 0063).
  readonly SettingsSection?: ComponentType<{ readonly context: WebContext }>;
  readonly settingsGroup?: SettingsGroup;
  readonly setupStep?: SetupStep;
  // What the plugin adds to Settings' own pages, such as the person's logins
  // on Accounts.
  readonly settingsParts?: {
    readonly General?: ComponentType<{ readonly context: WebContext }>;
    readonly Accounts?: ComponentType<{ readonly context: WebContext }>;
    // On a Profile's page, such as which logins it keeps of its own.
    readonly Profile?: ComponentType<{
      readonly context: WebContext;
      readonly profileId: string;
    }>;
  };
  readonly SessionHeader?: ComponentType<SessionPartProps>;
  // Drawn above a Session's composer, such as the agent's checklist.
  readonly Composer?: ComponentType<SessionPartProps>;
  // Tools whose calls the plugin draws instead of a work step, by name.
  readonly tools?: Readonly<Record<string, ComponentType<ToolCallProps>>>;
  // Extension widgets the plugin draws in their place, by widget key.
  readonly widgets?: Readonly<Record<string, ComponentType<WidgetProps>>>;
  // Repositories New Session offers for what the person typed, such as the
  // ones on the git hosts they connected (ADR 0043), or for team work the
  // ones the team's bots reach.
  readonly repositories?: (
    context: WebContext,
    query: string,
    team: boolean,
  ) => Promise<readonly RepositoryChoice[]>;
}

// Rejects with the server's error message when the response isn't ok, with
// its code as the cause (ADR 0047).
export async function json<T>(response: Promise<Response>): Promise<T> {
  return (await (await ok(response)).json()) as T;
}

// Like json, for responses without a body.
export async function ok(response: Promise<Response>): Promise<Response> {
  const settled = await response;

  if (!settled.ok) {
    const { error, message } = (await settled.json().catch(() => ({}))) as {
      error?: unknown;
      message?: unknown;
    };

    const code = typeof error === "string" ? error : undefined;

    throw new Error(
      typeof message === "string"
        ? message
        : (code ?? `${String(settled.status)} ${settled.statusText}`),
      { cause: code },
    );
  }

  return settled;
}

interface Watcher {
  readonly topics: readonly string[];
  readonly onChange: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

// The part of a browser EventSource that watchChanges uses.
interface ChangeStream {
  readonly readyState: number;
  addEventListener(
    type: "open" | "error" | "message",
    listener: (event: { readonly data: string }) => void,
  ): void;
  close(): void;
}

const closedState = 2;

// A burst of changes, such as a turn starting and its title arriving,
// becomes one fetch.
const settleMs = 250;

const watchers = new Set<Watcher>();
let stream: ChangeStream | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let failures = 0;

function notify(watcher: Watcher): void {
  clearTimeout(watcher.timer);
  watcher.timer = setTimeout(watcher.onChange, settleMs);
}

// A browser reconnects by itself after the connection drops, but not after
// an error response, such as while the server restarts. Either way changes
// were missed, so watchers fetch again once the stream opens.
function connect(): void {
  const { EventSource } = globalThis as unknown as {
    EventSource: new (url: string) => ChangeStream;
  };

  const source = new EventSource("/api/changes");
  let lost = failures > 0;
  stream = source;

  source.addEventListener("message", (event) => {
    const { topic } = JSON.parse(event.data) as { topic: string };

    for (const watcher of watchers) {
      if (watcher.topics.includes(topic)) {
        notify(watcher);
      }
    }
  });

  source.addEventListener("error", () => {
    lost = true;

    if (source.readyState === closedState && stream === source) {
      void reconnect(source);
    }
  });

  source.addEventListener("open", () => {
    failures = 0;

    if (lost) {
      lost = false;
      watchers.forEach(notify);
    }
  });
}

// An EventSource doesn't say which error response closed it, and a signed
// out browser would otherwise retry forever.
async function reconnect(source: ChangeStream): Promise<void> {
  const status = await fetch("/api/changes").then(
    async (response) => {
      await response.body?.cancel();

      return response.status;
    },
    () => undefined,
  );

  if (stream !== source) {
    return;
  }

  if (status === 401) {
    (
      globalThis as unknown as { location: { reload: () => void } }
    ).location.reload();

    return;
  }

  retry = setTimeout(connect, Math.min(1000 * 2 ** failures, 30_000));
  failures++;
}

// Calls onChange when the server says one of the topics changed, and after
// the page reconnects, since changes sent while it was away are not resent
// (ADR 0038). One stream serves the whole page.
export function watchChanges(
  topics: readonly string[],
  onChange: () => void,
): () => void {
  const watcher: Watcher = { topics, onChange };
  watchers.add(watcher);

  if (stream === undefined) {
    connect();
  }

  return () => {
    clearTimeout(watcher.timer);
    watchers.delete(watcher);

    if (watchers.size === 0) {
      clearTimeout(retry);
      stream?.close();
      stream = undefined;
      failures = 0;
    }
  };
}

// Loads data for a component, again when key changes, on reload(), when one
// of the topics or the plugin's changes changes, and every everyMs for data
// that changes outside Pipoca. changes are named as the plugin's routes name
// them. Stale results for an old key, and results older than the ones
// shown, are dropped.
// A failed first load is thrown during render, for the error boundary the
// web app puts around every plugin part; a failed refresh keeps the last
// value.
export function useLoaded<T>(
  load: () => Promise<T>,
  key: string,
  {
    topics = [],
    changes = [],
    everyMs,
  }: {
    readonly topics?: readonly string[];
    readonly changes?: readonly string[];
    readonly everyMs?: number;
  } = {},
): { readonly value: T | undefined; readonly reload: () => void } {
  const plugin = useScope();
  const [loaded, setLoaded] = useState<{ key: string; value: T }>();
  const [failed, setFailed] = useState<{ key: string; error: unknown }>();
  const [version, setVersion] = useState(0);
  const run = useEffectEvent(load);
  if (changes.length > 0 && plugin === undefined) {
    throw new Error(
      "changes name a plugin's topics, so only its parts watch them",
    );
  }

  // A string, so a new array with the same topics doesn't fetch again.
  const watched = [
    ...topics,
    ...changes.map((name) => topicOf(plugin ?? "", name)),
  ].join(" ");

  useEffect(() => {
    const order = responseOrder();

    const fetchNow = (): void => {
      const request = order.send();

      run().then(
        (value) => {
          if (order.accept(request)) {
            setLoaded({ key, value });
          }
        },
        (error: unknown) => {
          if (order.accept(request)) {
            setFailed({ key, error });
          }
        },
      );
    };

    fetchNow();

    const unwatch =
      watched === "" ? undefined : watchChanges(watched.split(" "), fetchNow);

    const timer =
      everyMs === undefined ? undefined : setInterval(fetchNow, everyMs);

    return () => {
      order.drop();
      unwatch?.();
      clearInterval(timer);
    };
  }, [key, version, watched, everyMs]);

  const value = loaded?.key === key ? loaded.value : undefined;

  if (value === undefined && failed?.key === key) {
    throw failed.error;
  }

  return {
    value,
    reload: () => {
      setVersion((current) => current + 1);
    },
  };
}

const units = [
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
] as const;

// How long ago a time was, such as "5m ago".
export function ago(time: string, now: number): string {
  const elapsed = now - Date.parse(time);
  const unit = units.find(([, ms]) => elapsed >= ms);

  return unit
    ? `${String(Math.floor(elapsed / unit[1]))}${unit[0]} ago`
    : "just now";
}

// The current time, again every everyMs, for "5m ago" labels.
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, everyMs);

    return () => {
      clearInterval(timer);
    };
  }, [everyMs]);

  return now;
}
