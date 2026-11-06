import type {
  Environment,
  EnvironmentTemplate,
  SessionEvent,
} from "@pipoca/protocol";
import {
  type ComponentType,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useState,
} from "react";
import { watchChanges } from "./changes";
import { responseOrder } from "./responses";
import { topicOf, useScope } from "./shell";

export { ConfigForm } from "./config-form";
export {
  defineWeb,
  Hidden,
  href,
  SessionView,
  Slot,
  type Slots,
  useApi,
  useSessionState,
  useToolResults,
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

export interface MountedSession {
  readonly id: string;
  // Every event the Session view receives, from the start of its stream.
  readonly events: (listener: (event: SessionEvent) => void) => () => void;
  // Sends a message as the user, such as one of the plugin's Pi commands.
  readonly send: (text: string) => Promise<void>;
}

export interface PageProps {
  // The rest of the address after the plugin's page, "" on the page itself.
  readonly path: string;
}

// The home screen, at the root of the app (ADR 0035).
export interface HomeProps {
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
  readonly done: () => Promise<boolean>;
  // The kernel's topics, and the plugin's own changes as its routes name them.
  readonly topics?: readonly string[];
  readonly changes?: readonly string[];
  readonly Step: ComponentType;
}

export interface NavItemsProps {
  // The open path inside the plugin's page, undefined when it isn't open.
  readonly path: string | undefined;
}

// A notice the plugin sent a Session, drawn in its chat (ADR 0028).
export interface NoticeProps {
  readonly text: string;
  readonly data: unknown;
}

// A link of the plugin's own scheme in a chat answer, as [label](scheme:target).
export interface LinkProps {
  readonly target: string;
  readonly label: string;
}

export interface SessionPartProps {
  readonly session: MountedSession;
}

export interface EnvironmentSectionProps {
  readonly environment: Environment;
}

export interface TemplateSectionProps {
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
