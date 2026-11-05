import {
  type ComponentType,
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
} from "react";
import type { Person } from "@pipoca/protocol";

export interface Viewer {
  readonly person: Pick<Person, "id" | "name" | "admin">;
  readonly admin: boolean;
  readonly team: boolean;
}

export interface Fill {
  readonly plugin: string;
  readonly Component: ComponentType<never>;
}

// What the web app gives the parts it draws.
export interface Shell {
  readonly viewer: Viewer;
  readonly fills: (slot: string) => readonly Fill[];
  // Draws a plugin's part inside the app's error boundary for it.
  readonly part: (plugin: string, children: ReactNode) => ReactNode;
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

export function usePlugin(): string {
  const plugin = useContext(PluginContext);

  if (plugin === undefined) {
    throw new Error("this hook works only in a plugin's part");
  }

  return plugin;
}
