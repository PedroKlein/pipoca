import type { ComponentType, ReactElement, ReactNode } from "react";
import type { PluginDefinition } from "../src/definition";
import { PluginScope, type Shell, ShellProvider } from "./shell";

// A plugin's part as the web app draws it, for the plugin's own tests: for a
// signed-in person, with other plugins' parts filling slots by name.
export function TestShell({
  plugin,
  fills = {},
  children,
}: {
  readonly plugin: Pick<PluginDefinition, "id">;
  readonly fills?: Readonly<Record<string, ComponentType<never>>>;
  readonly children: ReactNode;
}): ReactElement {
  const shell: Shell = {
    viewer: {
      person: { id: "ana", name: "Ana", admin: false },
      admin: false,
      team: false,
    },
    fills: (slot) => {
      const Component = fills[slot];

      return Component === undefined ? [] : [{ plugin: "other", Component }];
    },
    part: (_plugin, child): ReactNode => child,
  };

  return (
    <ShellProvider shell={shell}>
      <PluginScope plugin={plugin.id}>{children}</PluginScope>
    </ShellProvider>
  );
}
