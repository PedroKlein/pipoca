import {
  ConfigForm,
  type NavItemsProps,
  type PullRequestProps,
  type ToolCallProps,
  type WebContext,
  type WebPart,
  type WebPlugin,
  type WidgetProps,
} from "@pipoca/plugins/web";
import { type Shell, ShellProvider } from "@pipoca/plugins/web/shell";
import {
  apiPath,
  type PluginInfo,
  type PluginSettings,
  type RepositoryChoice,
  type Session,
} from "@pipoca/protocol";
import * as sdk from "@pipoca/plugins";
import * as plugins from "@pipoca/plugins/web";
import * as ui from "@pipoca/ui";
import * as react from "react";
import {
  type ComponentType,
  createElement,
  type ReactElement,
  type ReactNode,
  useMemo,
  useSyncExternalStore,
} from "react";
import * as reactDom from "react-dom";
import * as reactDomClient from "react-dom/client";
import * as jsxRuntime from "react/jsx-runtime";
import { api } from "./api";
import { EmbeddedSession } from "./embedded-session";
import { PluginBoundary } from "./plugin-boundary";
import { webRegistry } from "./registry";

type Module = Readonly<Record<string, unknown>>;

// The web parts of the plugins built into this bundle (ADR 0015).
const builtIn: readonly {
  readonly id: string;
  readonly plugin?: Module;
  readonly web?: WebPart;
}[] = webRegistry;

// A web part the shell draws, a v2 one drawn through the v1 fields.
interface ShellPlugin extends WebPlugin {
  readonly part?: WebPart;
  readonly slots?: Readonly<Record<string, ComponentType<never>>>;
  // Its pages have no place in the sidebar.
  readonly unlisted?: boolean;
}

let enabled: readonly ShellPlugin[] = [];
const webErrors = new Map<string, string>();
let settings: ReadonlyMap<string, PluginSettings> = new Map();
let titles: ReadonlyMap<string, string> = new Map();
let inTeamWork: ReadonlySet<string> = new Set();
const teamWorkListeners = new Set<() => void>();

// An installed plugin's web part is bundled with these left out, and reads
// them from here, so the page has one React and one design system (ADR 0022).
Object.assign(globalThis, {
  pipocaShared: {
    react,
    "react/jsx-runtime": jsxRuntime,
    "react-dom": reactDom,
    "react-dom/client": reactDomClient,
    "@pipoca/ui": ui,
    "@pipoca/plugins": sdk,
    "@pipoca/plugins/web": plugins,
  },
});

export async function loadPlugins(): Promise<void> {
  const listed = await api("plugins.list");
  const on = listed.filter(({ state }) => state === "on");

  const installed = await Promise.all(
    on.flatMap(({ id, webPart }) =>
      webPart === undefined ? [] : [importWebPart(id, webPart)],
    ),
  );

  settings = new Map(on.map(({ id, values }) => [id, values]));
  titles = new Map(on.map(({ id, title }) => [id, title]));

  enabled = [
    ...builtIn.flatMap(({ id, plugin, web }) =>
      on.some((each) => each.id === id)
        ? [web === undefined ? shellPlugin(id, plugin) : adapted(web)]
        : [],
    ),
    ...installed.flatMap((plugin) => (plugin ? [plugin] : [])),
  ];

  inTeamWork = teamWorkOf(on);

  // Admins turn plugins on and off in team work while pages stay open.
  plugins.watchChanges(["plugins"], () => {
    void api("plugins.list")
      .then((changed) => {
        inTeamWork = teamWorkOf(changed);

        for (const listener of teamWorkListeners) {
          listener();
        }
      })
      .catch(() => undefined);
  });
}

function teamWorkOf(listed: readonly PluginInfo[]): ReadonlySet<string> {
  return new Set(
    listed.flatMap(({ id, state, teamWork }) =>
      state === "on" && teamWork ? [id] : [],
    ),
  );
}

function watchTeamWork(listener: () => void): () => void {
  teamWorkListeners.add(listener);

  return () => {
    teamWorkListeners.delete(listener);
  };
}

function shellPlugin(id: string, module: Module | undefined): ShellPlugin {
  const plugin = Object.values(module ?? {}).find(
    (value) => (value as { readonly name?: unknown } | null)?.name === id,
  );

  if (plugin === undefined) {
    throw new Error(`the ${id} web module exports no web part`);
  }

  return bridged(plugin as WebPlugin);
}

// A v1 part's PullRequest fills the slot that changes declares.
function bridged(plugin: WebPlugin): ShellPlugin {
  const { name, PullRequest } = plugin;

  if (PullRequest === undefined) {
    return plugin;
  }

  const Status = (props: Omit<PullRequestProps, "context">): ReactElement =>
    createElement(PullRequest, { ...props, context: pluginContext(name) });

  return { ...plugin, slots: { "pullRequest.status": Status } };
}

function isPart(value: unknown): value is WebPart {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly plugin?: { readonly id?: unknown } }).plugin
      ?.id === "string"
  );
}

function adapted(part: WebPart): ShellPlugin {
  const { id } = part.plugin;

  const slots = (part.slots ?? {}) as Readonly<
    Record<string, ComponentType<never>>
  >;

  const slotted = <Props>(prefix: string) =>
    Object.fromEntries(
      Object.entries(slots).flatMap(([name, Component]) =>
        name.startsWith(prefix)
          ? [[name.slice(prefix.length), Component as ComponentType<Props>]]
          : [],
      ),
    );

  const slot = <Props>(name: string): ComponentType<Props> | undefined =>
    slots[name] as ComponentType<Props> | undefined;

  const pages = (part.pages ?? []).filter(({ area }) => area !== "hub");
  const listed = pages.find(({ nav }) => nav !== undefined);
  const first = listed ?? pages[0];

  const byLength = [...pages].sort(
    (one, other) => other.path.length - one.path.length,
  );

  const Page = ({ path }: { readonly path: string }): ReactElement | null => {
    const page = byLength.find(
      (each) =>
        each.path === "" ||
        path === each.path ||
        path.startsWith(`${each.path}/`),
    );

    return page
      ? createElement(page.Page, {
          path: page.path === "" ? path : path.slice(page.path.length + 1),
        })
      : null;
  };

  const settingsSection = part.settings && {
    SettingsSection: (part.settings.Section ??
      (() =>
        createElement(ConfigForm, { plugin: part.plugin }))) as NonNullable<
      WebPlugin["SettingsSection"]
    >,
    settingsGroup: part.settings.group,
  };

  const optional = <K extends keyof WebPlugin>(
    key: K,
    value: WebPlugin[K] | undefined,
  ): Partial<WebPlugin> => (value === undefined ? {} : { [key]: value });

  const withSlot = (
    key: string,
    Component: ComponentType<never> | undefined,
  ): Readonly<Record<string, ComponentType<never>>> =>
    Component === undefined ? {} : { [key]: Component };

  const panels = slotted<{ readonly title: string }>("hub.panel:");

  return {
    name: id,
    part,
    slots,
    ...(listed === undefined && { unlisted: true }),
    ...(first && {
      nav: {
        label: first.label,
        Page,
        ...(listed?.nav?.Items && {
          Items: listed.nav.Items as ComponentType<NavItemsProps>,
        }),
        ...(listed?.nav?.fills && { fills: listed.nav.fills }),
        ...(listed?.nav?.pinned === true && { pinned: true }),
      },
    }),
    hub: {
      panels: Object.fromEntries(
        Object.entries(panels).map(([key, Panel]) => [
          key,
          {
            title: pluginTitle(id),
            Panel: () => createElement(Panel, { title: pluginTitle(id) }),
          },
        ]),
      ),
      pages: Object.fromEntries(
        (part.pages ?? [])
          .filter(({ area }) => area === "hub")
          .map((page) => [
            page.path,
            {
              label: page.label,
              Page: () => createElement(page.Page, { path: "" }),
            },
          ]),
      ),
    },
    ...optional("Home", slot("home")),
    ...optional("sessionPath", part.sessionPath),
    notices: slotted("notice:"),
    links: slotted("link:"),
    tools: slotted("session.toolCall:"),
    ...optional("SessionHeader", slot("session.header")),
    ...optional("Composer", slot("session.composer")),
    ...optional("EnvironmentSection", slot("environment.section")),
    ...optional("TemplateSection", slot("template.section")),
    ...settingsSection,
    ...optional("setupStep", part.setup?.[0]),
    settingsParts: {
      ...withSlot("General", slot("settings.general")),
      ...withSlot("Accounts", slot("settings.accounts")),
      ...withSlot("Profile", slot("settings.profile")),
    },
  };
}

const shell: Omit<Shell, "viewer"> = {
  fills: (name) =>
    enabled.flatMap(({ name: plugin, slots }) => {
      const Component = slots?.[name];

      return Component === undefined ? [] : [{ plugin, Component }];
    }),
  part: (plugin, children) =>
    createElement(PluginBoundary, { name: plugin, children }),
};

// What the plugins' parts draw inside: who looks, and every enabled
// plugin's slots.
export function PluginShell({
  viewer,
  children,
}: {
  readonly viewer: Shell["viewer"];
  readonly children: ReactNode;
}): ReactElement {
  const value = useMemo(() => ({ ...shell, viewer }), [viewer]);

  return createElement(ShellProvider, { shell: value, children });
}

async function importWebPart(
  id: string,
  url: string,
): Promise<ShellPlugin | undefined> {
  try {
    // The page waits for every web part before it draws, so one that never
    // finishes loading can't keep it blank.
    const { default: plugin, web } = (await Promise.race([
      import(url),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error("it took longer than 10 seconds to load"));
        }, 10_000);
      }),
    ])) as { default?: WebPlugin; web?: unknown };

    if (web !== undefined) {
      if (!isPart(web) || web.plugin.id !== id) {
        throw new Error(`its web export must be a web part for ${id}`);
      }

      return adapted(web);
    }

    if (plugin?.name !== id) {
      throw new Error(`its default export must be a web part named ${id}`);
    }

    if (
      plugin.nav !== undefined &&
      (typeof plugin.nav.label !== "string" ||
        typeof plugin.nav.Page !== "function")
    ) {
      throw new Error("its nav needs a label and a Page component");
    }

    return bridged(plugin);
  } catch (error) {
    webErrors.set(id, error instanceof Error ? error.message : String(error));

    return undefined;
  }
}

// Why an installed plugin's web part didn't load in this page.
export function webPartError(id: string): string | undefined {
  return webErrors.get(id);
}

export function pluginTitle(name: string): string {
  return titles.get(name) ?? name;
}

export function enabledPlugins(): readonly WebPlugin[] {
  return enabled;
}

// The plugins whose parts draw in a Session: in team work, only the ones
// that load there (ADR 0067).
export function useSessionPlugins(team: boolean): readonly WebPlugin[] {
  const switches = useSyncExternalStore(watchTeamWork, () => inTeamWork);

  return useMemo(
    () => (team ? enabled.filter(({ name }) => switches.has(name)) : enabled),
    [team, switches],
  );
}

const contexts = new Map<string, WebContext>();

export function pluginContext(name: string): WebContext {
  const cached = contexts.get(name);
  if (cached) {
    return cached;
  }

  const context: WebContext = {
    request: async (path, init) =>
      fetch(
        path.startsWith("/")
          ? path
          : apiPath("ext", { params: { plugin: name, path } }),
        init,
      ),
    openSession: (sessionId) => {
      location.hash = sessionId;
    },
    href: (path) => `#plugin/${name}/${path}`,
    settings: settings.get(name) ?? {},
    SessionView: EmbeddedSession,
  };

  contexts.set(name, context);

  return context;
}

export interface Claimed<Props> {
  readonly plugin: string;
  readonly Component: ComponentType<Props>;
}

// The enabled plugin that draws calls of a tool, if any (ADR 0030).
export function toolRenderer(name: string): Claimed<ToolCallProps> | undefined {
  return claimed(name, ({ tools }) => tools);
}

// The enabled plugin that draws an extension widget, if any (ADR 0030).
export function widgetRenderer(key: string): Claimed<WidgetProps> | undefined {
  return claimed(key, ({ widgets }) => widgets);
}

function claimed<Props>(
  key: string,
  slots: (
    plugin: WebPlugin,
  ) => Readonly<Record<string, ComponentType<Props>>> | undefined,
): Claimed<Props> | undefined {
  for (const plugin of enabled) {
    const Component = slots(plugin)?.[key];

    if (Component) {
      return { plugin: plugin.name, Component };
    }
  }

  return undefined;
}

export interface NavEntry {
  readonly name: string;
  readonly label: string;
  readonly Items?: ComponentType<NavItemsProps>;
  readonly pinned: boolean;
}

// A plugin whose search fails offers nothing, so the others still show.
export async function searchRepositories(
  query: string,
  team: boolean,
): Promise<readonly RepositoryChoice[]> {
  const found = await Promise.all(
    enabled.map(
      async ({ name, repositories }) =>
        repositories?.(pluginContext(name), query, team).catch(() => []) ?? [],
    ),
  );

  return found.flat();
}

export function navEntries(): readonly NavEntry[] {
  return enabled.flatMap(({ name, nav, unlisted }) =>
    nav && unlisted !== true
      ? [
          {
            name,
            label: nav.label,
            pinned: nav.pinned === true,
            ...(nav.Items && { Items: nav.Items }),
          },
        ]
      : [],
  );
}

// "plugin/projects/p1" is the projects page open at "p1".
export function pluginRoute(
  route: string,
): { readonly name: string; readonly path: string } | undefined {
  const match = /^plugin\/([^/]+)\/?(.*)$/.exec(route);

  return match ? { name: match[1] ?? "", path: match[2] ?? "" } : undefined;
}

// A Session a plugin owns opens in that plugin's page (ADR 0028).
export function sessionHref(session: Session): string {
  const plugin = enabled.find(({ name }) => name === session.owner?.plugin);
  const path = guarded(() => plugin?.sessionPath?.(session));

  return plugin && path !== undefined
    ? `#plugin/${plugin.name}/${path}`
    : `#${session.id}`;
}

export function pageFills(name: string, path: string): boolean {
  return (
    guarded(() =>
      enabled.find((plugin) => plugin.name === name)?.nav?.fills?.(path),
    ) === true
  );
}

// A plugin's function the shell calls while it draws, outside any plugin's
// error boundary, so a throw counts as no answer instead of breaking the app.
function guarded<T>(call: () => T): T | undefined {
  try {
    return call();
  } catch {
    return undefined;
  }
}
