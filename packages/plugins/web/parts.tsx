import type { RepositoryChoice, Session } from "@pipoca/protocol";
import type { IconName } from "@pipoca/ui";
import {
  type ComponentType,
  createElement,
  Fragment,
  type ReactElement,
  useEffect,
  useMemo,
  useState,
} from "react";
import { pluginClient, type TypedClient } from "../src/client";
import type { PluginDefinition } from "../src/definition";
import { transcriptReader } from "../src/transcript";
import type {
  CodeBlockProps,
  EmbeddedSessionProps,
  EnvironmentSectionProps,
  HomeProps,
  LinkProps,
  MountedSession,
  NavItemsProps,
  NoticeProps,
  PageProps,
  SessionFilesProps,
  SessionPartProps,
  SettingsGroup,
  SetupStep,
  TemplateSectionProps,
  ToolCallProps,
  ToolPermissionProps,
} from "./index";
import { storedConfig } from "./config-form";
import { useLoaded } from "./index";
import { type Shell, useShell, usePlugin, type Viewer } from "./shell";

type Nothing = Readonly<Record<string, never>>;

// The places plugins draw in. A plugin adds its own by augmenting this
// interface, and fills another's by its name.
export interface Slots {
  "session.composer": SessionPartProps;
  "session.header": SessionPartProps;
  "session.files": SessionFilesProps;
  [call: `session.toolCall:${string}`]: ToolCallProps;
  [ask: `session.permission:${string}`]: ToolPermissionProps;
  [notice: `notice:${string}`]: NoticeProps;
  [link: `link:${string}`]: LinkProps;
  [block: `codeBlock:${string}`]: CodeBlockProps;
  home: HomeProps;
  "environment.section": EnvironmentSectionProps;
  "template.section": TemplateSectionProps;
  "settings.general": Nothing;
  "settings.accounts": Nothing;
  "settings.base-profile": Nothing;
  "settings.profile": { readonly profileId: string };
}

export interface WebPage {
  // Under the plugin's page, "" for the page itself.
  readonly path: string;
  readonly label: string;
  readonly icon?: IconName;
  readonly Page: ComponentType<PageProps>;
  // In the sidebar. Pinned is for someone who never changed their pins.
  // Items list under the entry, and Live lists work below all the entries,
  // such as active Projects; a hub page's Live shows in the team's sidebar.
  readonly nav?: {
    readonly Items?: ComponentType<NavItemsProps>;
    readonly Live?: ComponentType<NavItemsProps>;
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
  // At most one step for the server's setup and one for each person's.
  readonly setup?: readonly SetupStep[];
  // Panels an admin lays out on the team hub's pages, by key (ADR 0067).
  readonly panels?: Readonly<
    Record<string, { readonly title: string; readonly Panel: ComponentType }>
  >;
  readonly slots?: { readonly [K in keyof Slots]?: ComponentType<Slots[K]> };
  readonly sessionPath?: (session: Session) => string;
  // Repositories New Session offers for what the person typed, such as the
  // ones on the git hosts they connected (ADR 0043), or for team work the
  // ones the team's bots reach.
  readonly repositories?: (
    query: string,
    team: boolean,
    api: TypedClient,
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

// The app's Session view: chat, composer, prompts and header, inside a
// plugin's page (ADR 0028).
export function SessionView(props: EmbeddedSessionProps): ReactElement {
  return createElement(useShell().SessionView, props);
}

// The address of a path inside a plugin's page, such as a Project.
export function href(
  plugin: Pick<PluginDefinition, "id">,
  path: string,
): string {
  return `#plugin/${plugin.id}/${path}`;
}

// Fills a tool's call slot to leave its calls out of the chat.
export function Hidden(): null {
  return null;
}

export function useViewer(): Viewer {
  return useShell().viewer;
}

// Opens a Session with text waiting in its composer; it never sends.
export function useDraft(): Shell["draft"] {
  return useShell().draft;
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
): readonly { readonly details: D | undefined; readonly isError: boolean }[] {
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
