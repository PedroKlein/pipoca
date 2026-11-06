import type { RepositoryChoice, Session } from "@pipoca/protocol";
import {
  type ComponentType,
  createElement,
  Fragment,
  type ReactElement,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
} from "react";
import { pluginClient, type TypedClient } from "../src/client";
import type { PluginDefinition } from "../src/definition";
import { transcriptReader } from "../src/transcript";
import type {
  EnvironmentSectionProps,
  HomeProps,
  LinkProps,
  MountedSession,
  NavItemsProps,
  NoticeProps,
  PageProps,
  SessionPartProps,
  SettingsGroup,
  SetupStep,
  TemplateSectionProps,
  ToolCallProps,
} from "./index";
import { useLoaded, watchChanges } from "./index";
import { topicOf, useShell, usePlugin, type Viewer } from "./shell";

type Own<T> = Omit<T, "context">;

type Nothing = Readonly<Record<string, never>>;

// The places plugins draw in. A plugin adds its own by augmenting this
// interface, and fills another's by its name.
export interface Slots {
  "session.composer": Own<SessionPartProps>;
  "session.header": Own<SessionPartProps>;
  [call: `session.toolCall:${string}`]: Own<ToolCallProps>;
  [notice: `notice:${string}`]: Own<NoticeProps>;
  [link: `link:${string}`]: Own<LinkProps>;
  home: Own<HomeProps>;
  [panel: `hub.panel:${string}`]: { readonly title: string };
  "environment.section": Own<EnvironmentSectionProps>;
  "template.section": Own<TemplateSectionProps>;
  "settings.general": Nothing;
  "settings.accounts": Nothing;
  "settings.profile": { readonly profileId: string };
}

export interface WebPage {
  // Under the plugin's page, "" for the page itself.
  readonly path: string;
  readonly label: string;
  readonly Page: ComponentType<Own<PageProps>>;
  // In the sidebar. Pinned is for someone who never changed their pins.
  readonly nav?: {
    readonly Items?: ComponentType<Own<NavItemsProps>>;
    readonly pinned?: boolean;
    readonly fills?: (path: string) => boolean;
  };
  // A screen of Team setup, which only admins open, is listed with what
  // team work runs on or with its rules.
  readonly area?: "personal" | "hub" | "setup";
  readonly group?: "runs-on" | "rules";
}

export interface WebPart<P extends PluginDefinition = PluginDefinition> {
  readonly plugin: P;
  readonly pages?: readonly WebPage[];
  // A section on the Settings page: the config's form, or the plugin's own.
  readonly settings?: {
    readonly group: SettingsGroup;
    readonly form?: "auto";
    readonly Section?: ComponentType;
  };
  readonly setup?: readonly SetupStep[];
  readonly slots?: { readonly [K in keyof Slots]?: ComponentType<Slots[K]> };
  readonly sessionPath?: (session: Session) => string;
  // Repositories New Session offers for what the person typed, such as the
  // ones on the git hosts they connected (ADR 0043), or for team work the
  // ones the team's bots reach.
  readonly repositories?: (
    query: string,
    team: boolean,
  ) => Promise<readonly RepositoryChoice[]>;
}

export function defineWeb<P extends PluginDefinition>(
  plugin: P,
  part: Omit<WebPart<P>, "plugin">,
): WebPart<P> {
  return { ...part, plugin };
}

// Every enabled plugin's part for the slot.
export function Slot<K extends keyof Slots>(
  props: { readonly name: K } & Slots[K],
): ReactElement | null {
  const shell = useShell();
  const { name, ...rest } = props;
  const fills = shell.fills(name);

  if (fills.length === 0) {
    return null;
  }

  return (
    <>
      {fills.map(({ plugin, Component }) => (
        <Fragment key={plugin}>
          {shell.part(plugin, createElement(Component, rest as never))}
        </Fragment>
      ))}
    </>
  );
}

// Fills a tool's call slot to leave its calls out of the chat.
export function Hidden(): null {
  return null;
}

export function useViewer(): Viewer {
  return useShell().viewer;
}

export function useApi(plugin: Pick<PluginDefinition, "id">): TypedClient {
  return useMemo(() => pluginClient({ id: plugin.id }), [plugin.id]);
}

// The plugin's config as pipoca.json keeps it, its secrets sealed or named,
// for admins.
export function useConfig(
  plugin: Pick<PluginDefinition, "id">,
): Readonly<Record<string, unknown>> | undefined {
  return useLoaded(async () => storedConfig(plugin.id), plugin.id, {
    topics: ["plugins"],
  }).value;
}

export async function storedConfig(
  id: string,
): Promise<Readonly<Record<string, unknown>>> {
  const response = await fetch(`/api/plugins/${id}/config`);

  if (!response.ok) {
    throw new Error(`the config didn't load: ${String(response.status)}`);
  }

  const { value } = (await response.json()) as { readonly value: unknown };

  return (value ?? {}) as Readonly<Record<string, unknown>>;
}

// Calls fn when one of the plugin's changes, named as its routes name it, or
// another plugin's <plugin>.<name>, changes.
export function useTopic(name: string, fn: () => void): void {
  const changed = useEffectEvent(fn);
  const topic = topicOf(usePlugin(), name);

  useEffect(
    () =>
      watchChanges([topic], () => {
        changed();
      }),
    [topic],
  );
}

// What the plugin's Session part last published under key.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- only the plugin knows the shape it published
export function useSessionState<T>(
  session: MountedSession,
  key: string,
): T | undefined {
  const plugin = usePlugin();
  const [state, setState] = useState<{ readonly data: T }>();

  useEffect(
    () =>
      session.events((event) => {
        if (
          event.type === "live" &&
          event.event.type === "plugin" &&
          event.event.plugin === plugin &&
          event.event.key === key
        ) {
          setState({ data: event.event.data as T });
        }
      }),
    [session, plugin, key],
  );

  return state?.data;
}

const none: readonly string[] = [];

// The results of a tool's calls in the Session's transcript, oldest first.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- only the plugin knows its tool's details
export function useToolResults<D>(
  session: MountedSession,
  tool: string,
): readonly { readonly details: D; readonly isError: boolean }[] {
  const [seen, setSeen] = useState<{
    readonly session: MountedSession;
    readonly lines: readonly string[];
  }>();

  useEffect(
    () =>
      session.events((event) => {
        if (event.type === "entry") {
          setSeen((known) => {
            const lines = known?.session === session ? [...known.lines] : [];
            lines[event.line] = event.entry;

            return { session, lines };
          });
        }
      }),
    [session],
  );

  const lines = seen?.session === session ? seen.lines : none;

  return useMemo(
    () =>
      transcriptReader(() => lines)
        .toolResults<D>("", tool)
        .map(({ details, isError }) => ({ details, isError })),
    [lines, tool],
  );
}
