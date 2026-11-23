import {
  type ComponentType,
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
} from "react";
import type { Person, RepositoryChoice } from "@pipoca/protocol";
import type { Attachment } from "./attach-menu";
import type { EmbeddedSessionProps } from "./index";

export interface Viewer {
  readonly person: Pick<Person, "id" | "name" | "admin">;
  readonly team: boolean;
}

interface Fill {
  readonly plugin: string;
  readonly Component: ComponentType<never>;
}

// What the web app gives the parts it draws.
export interface Shell {
  readonly viewer: Viewer;
  readonly fills: (slot: string) => readonly Fill[];
  // Draws a plugin's part inside the app's error boundary for it.
  readonly part: (plugin: string, children: ReactNode) => ReactNode;
  // The app's own Session view, which a page embeds (ADR 0028).
  readonly SessionView: ComponentType<EmbeddedSessionProps>;
  // Puts text, and things attached, in the Session's composer for the
  // person to send, opening the Session unless its composer already shows.
  // Empty text keeps what the person typed.
  readonly draft: (
    sessionId: string,
    text: string,
    attachments?: readonly Attachment[],
  ) => void;
  // Opens the New session composer with text and attachments in it, for
  // the person to pick where it runs and start it.
  readonly newSession: (
    text: string,
    attachments?: readonly Attachment[],
  ) => void;
  // What every plugin's repository search finds for the query.
  readonly repositories: (
    query: string,
    team: boolean,
  ) => Promise<readonly RepositoryChoice[]>;
}

const ShellContext = createContext<Shell | undefined>(undefined);

const PluginContext = createContext<string | undefined>(undefined);

export function ShellProvider({
  shell,
  children,
}: {
  readonly shell: Shell;
  readonly children: ReactNode;
}): ReactElement {
  return <ShellContext value={shell}>{children}</ShellContext>;
}

// Marks what a plugin's part draws as that plugin's.
export function PluginScope({
  plugin,
  children,
}: {
  readonly plugin: string;
  readonly children: ReactNode;
}): ReactElement {
  return <PluginContext value={plugin}>{children}</PluginContext>;
}

export function useShell(): Shell {
  const shell = useContext(ShellContext);

  if (shell === undefined) {
    throw new Error("a plugin's part draws only inside the app");
  }

  return shell;
}

// The plugin whose part draws this, if a plugin's part does.
export function useScope(): string | undefined {
  return useContext(PluginContext);
}

// A topic as the server publishes it: one of this plugin's changes by the
// name its routes give it, or another plugin's as <plugin>.<name>.
export function topicOf(plugin: string, name: string): string {
  return name.includes(".") ? name : `${plugin}.${name}`;
}

export function usePlugin(): string {
  const plugin = useContext(PluginContext);

  if (plugin === undefined) {
    throw new Error("this hook works only in a plugin's part");
  }

  return plugin;
}
