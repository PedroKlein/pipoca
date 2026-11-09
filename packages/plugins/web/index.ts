import type {
  Environment,
  EnvironmentTemplate,
  Permission,
  SessionEvent,
} from "@pipoca/protocol";
import {
  type ComponentType,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useState,
} from "react";
import type { TypedClient } from "../src/client";
import { watchChanges } from "./changes";
import { responseOrder } from "./responses";
import { topicOf, useScope } from "./shell";

export { ConfigForm } from "./config-form";
export { SessionPanel, SessionTab } from "./session-panel";
export { uploadBlob } from "./upload";
export {
  defineWeb,
  Hidden,
  href,
  SessionView,
  Slot,
  type Slots,
  useApi,
  useConfig,
  useDraft,
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

// The kernel's own steps of the server's setup and of each person's, which
// a plugin's step goes after (ADR 0072).
export type ServerSetupStepId =
  "who" | "plugins" | "default-profile" | "where" | "newcomers";

export type PersonSetupStepId = "welcome" | "where" | "profile";

// A kernel step, or another plugin's step with the kernel step to follow
// when that plugin's step isn't shown.
export type SetupStepAnchor<K extends string> =
  K | { readonly plugin: string; readonly or: K };

export interface SetupStepProps {
  // The server is just for the person setting it up. A plugin with a step
  // in both setups then shows only its personal one, which sets up both.
  readonly solo: boolean;
}

// A step a plugin adds to setup (ADR 0063, ADR 0072): to the server's,
// which an admin does once for what the server shares, or to each person's.
// It goes after a kernel step, by default after Plugins or Welcome, or
// right after another plugin's step. Steps on the same anchor go in the
// order the plugins load. done
// says whether it was already done, and reloads when one of its topics
// changes. A personal step that isn't done stays on home as a reminder.
// A server step only for teams, such as sign-in, is left out on a server
// just for its person.
export type SetupStep = SetupStepAbout &
  (
    | {
        readonly audience: "server";
        readonly after?: SetupStepAnchor<ServerSetupStepId>;
        readonly teamOnly?: boolean;
      }
    | {
        readonly audience: "person";
        readonly after?: SetupStepAnchor<PersonSetupStepId>;
      }
  );

interface SetupStepAbout {
  // A few words in the list of steps, such as "A model".
  readonly title: string;
  readonly summary: string;
  // The step's page, such as "Connect a model".
  readonly heading: string;
  readonly description: string;
  readonly optional?: boolean;
  // Gives the step's page more room, such as for a grid of providers.
  readonly wide?: boolean;
  // A client of the plugin's routes, and of the kernel's for a path that
  // starts with /.
  readonly done: (api: TypedClient) => Promise<boolean>;
  // The kernel's topics, and the plugin's own changes as its routes name them.
  readonly topics?: readonly string[];
  readonly changes?: readonly string[];
  readonly Step: ComponentType<SetupStepProps>;
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

export interface CodeBlockProps {
  readonly code: string;
  // False while the agent is still writing the block.
  readonly complete: boolean;
}

export interface SessionPartProps {
  readonly session: MountedSession;
}

// Files dropped, pasted or picked in a Session's composer that aren't images
// for the model (ADR 0078), until the message is sent or one is removed.
export interface SessionFilesProps extends SessionPartProps {
  readonly files: readonly File[];
  readonly onRemove: (file: File) => void;
  // Whether some are still on their way, which holds the composer's Send.
  readonly onUploading: (uploading: boolean) => void;
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

// A permission prompt for a call of a plugin's tool, which the plugin draws
// in place of the kernel's (ADR 0050). It answers with onAnswer.
export interface ToolPermissionProps extends SessionPartProps {
  readonly title: string;
  readonly input: unknown;
  readonly onAnswer: (answer: Permission) => void;
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
