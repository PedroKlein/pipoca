import {
  ConfigForm,
  type NavItemsProps,
  type Slots,
  type ToolCallProps,
  type ToolPermissionProps,
  type WebPage,
  type WebPart,
} from "@pipoca/plugins/web";
import {
  type Shell,
  pluginClient,
  ShellProvider,
  watchChanges,
} from "@pipoca/plugins/web/host";
import type { PluginInfo, RepositoryChoice, Session } from "@pipoca/protocol";
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
import { request } from "./data/client";
import { prefillComposer } from "./session/composer/prefill";
import { EmbeddedSession } from "./session/embedded-session";
import { PluginBoundary } from "./plugin-boundary";
import { webRegistry } from "./registry";
import { href } from "./router";

// The web parts of the plugins built into this bundle (ADR 0015).
const builtIn: readonly { readonly id: string; readonly web: WebPart }[] =
  webRegistry;

let enabled: readonly WebPart[] = [];
const webErrors = new Map<string, string>();
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
  const listed = await request("plugins.list");
  const on = listed.filter(({ state }) => state === "on");

  const installed = await Promise.all(
    on.flatMap(({ id, webPart }) =>
      webPart === undefined ? [] : [importWebPart(id, webPart)],
    ),
  );

  titles = new Map(on.map(({ id, title }) => [id, title]));

  enabled = [
    ...builtIn.flatMap(({ id, web }) =>
      on.some((each) => each.id === id) ? [web] : [],
    ),
    ...installed.flatMap((plugin) => (plugin ? [plugin] : [])),
  ];

  inTeamWork = teamWorkOf(on);

  // Admins turn plugins on and off in team work while pages stay open.
  watchChanges(["plugins"], () => {
    void request("plugins.list")
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

function isPart(value: unknown): value is WebPart {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly plugin?: { readonly id?: unknown } }).plugin
      ?.id === "string"
  );
}

// A plugin's slots by name. Plugins add their own, so any name may be filled.
function slotsOf(
  part: WebPart,
): Readonly<Record<string, ComponentType<never> | undefined>> {
  return (part.slots ?? {}) as Readonly<
    Record<string, ComponentType<never> | undefined>
  >;
}

function filled(
  name: string,
  parts: readonly WebPart[] = enabled,
): ReturnType<Shell["fills"]> {
  return parts.flatMap((part) => {
    const Component = slotsOf(part)[name];

    return Component === undefined
      ? []
      : [{ plugin: part.plugin.id, Component }];
  });
}

interface Claimed<Props> {
  readonly plugin: string;
  readonly Component: ComponentType<Props>;
}

// What fills a slot, from the given plugins or every enabled one.
export function fillsOf<K extends keyof Slots>(
  name: K,
  parts?: readonly WebPart[],
): readonly Claimed<Slots[K]>[] {
  return filled(name, parts) as readonly Claimed<Slots[K]>[];
}

// A plugin's section on the Settings page: its own, or its config's form.
export function PluginSettings({
  part,
}: {
  readonly part: WebPart;
}): ReactElement {
  const Section = part.settings?.Section;

  return Section
    ? createElement(Section)
    : createElement(ConfigForm, { plugin: part.plugin });
}

const shell: Omit<Shell, "viewer"> = {
  fills: (name) => filled(name),
  part: (plugin, children) =>
    createElement(PluginBoundary, { name: plugin, children }),
  SessionView: EmbeddedSession,
  draft: (sessionId, text) => {
    prefillComposer(sessionId, text);
    location.hash = href("session", { id: sessionId });
  },
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
): Promise<WebPart | undefined> {
  try {
    // The page waits for every web part before it draws, so one that never
    // finishes loading can't keep it blank.
    const { web } = (await Promise.race([
      import(url),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error("it took longer than 10 seconds to load"));
        }, 10_000);
      }),
    ])) as { web?: unknown };

    if (!isPart(web) || web.plugin.id !== id) {
      throw new Error(`its web export must be a web part for ${id}`);
    }

    return web;
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

export function enabledPlugins(): readonly WebPart[] {
  return enabled;
}

// Only a web part says whether its plugin adds a setup step, so this knows
// for a built-in plugin that is off, and not for an installed one.
export function addsSetupStep(id: string): boolean {
  const part =
    enabled.find(({ plugin }) => plugin.id === id) ??
    builtIn.find((each) => each.id === id)?.web;

  return (part?.setup ?? []).length > 0;
}

// The plugins whose parts draw in a Session: in team work, only the ones
// that load there (ADR 0067).
export function useSessionPlugins(team: boolean): readonly WebPart[] {
  const switches = useSyncExternalStore(watchTeamWork, () => inTeamWork);

  return useMemo(
    () =>
      team ? enabled.filter(({ plugin }) => switches.has(plugin.id)) : enabled,
    [team, switches],
  );
}

// The enabled plugin that draws calls of a tool, if any (ADR 0030).
export function toolRenderer(name: string): Claimed<ToolCallProps> | undefined {
  return fillsOf(`session.toolCall:${name}`)[0];
}

// The enabled plugin that draws the permission prompt for a tool's calls.
export function permissionRenderer(
  name: string,
): Claimed<ToolPermissionProps> | undefined {
  return fillsOf(`session.permission:${name}`)[0];
}

export interface NavEntry {
  readonly name: string;
  readonly label: string;
  readonly Items?: ComponentType<NavItemsProps>;
  readonly pinned: boolean;
}

// A plugin's own pages, outside the team hub and its setup.
export function ownPages(name: string): readonly WebPage[] {
  return (
    enabled
      .find(({ plugin }) => plugin.id === name)
      ?.pages?.filter(({ area }) => area !== "hub" && area !== "setup") ?? []
  );
}

// The page the sidebar lists, if any.
function listedPage(name: string): WebPage | undefined {
  return ownPages(name).find(({ nav }) => nav !== undefined);
}

// What a plugin's page is called, the listed one first.
export function pageLabel(name: string): string | undefined {
  return (listedPage(name) ?? ownPages(name)[0])?.label;
}

// A plugin whose search fails offers nothing, so the others still show.
export async function searchRepositories(
  query: string,
  team: boolean,
): Promise<readonly RepositoryChoice[]> {
  const found = await Promise.all(
    enabled.map(
      async ({ plugin, repositories }) =>
        repositories?.(query, team, pluginClient({ id: plugin.id })).catch(
          () => [],
        ) ?? [],
    ),
  );

  return found.flat();
}

export function navEntries(): readonly NavEntry[] {
  return enabled.flatMap(({ plugin: { id } }) => {
    const listed = listedPage(id);

    return listed
      ? [
          {
            name: id,
            label: listed.label,
            pinned: listed.nav?.pinned === true,
            ...(listed.nav?.Items && { Items: listed.nav.Items }),
          },
        ]
      : [];
  });
}

// A Session a plugin owns opens in that plugin's page (ADR 0028).
export function sessionHref(session: Session): string {
  const part = enabled.find(({ plugin }) => plugin.id === session.plugin?.id);
  const path = guarded(() => part?.sessionPath?.(session));

  return part && path !== undefined
    ? href("plugin", { name: part.plugin.id, path })
    : href("session", { id: session.id });
}

export function pageFills(name: string, path: string): boolean {
  return guarded(() => listedPage(name)?.nav?.fills?.(path)) === true;
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
