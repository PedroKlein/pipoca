import type { MountedSession } from "@pipoca/plugins/web";
import { type ReactNode, useMemo } from "react";
import { PluginBoundary } from "../plugin-boundary";
import { pluginContext, useSessionPlugins } from "../plugins";

// Kept across renders so plugin parts re-render on their own events, not on
// every token.
export function usePluginParts(
  team: boolean,
  session: MountedSession,
): { readonly headers: ReactNode; readonly panels: ReactNode } {
  const parts = useSessionPlugins(team);

  const headers = useMemo(
    () =>
      parts.map(({ name, SessionHeader }) =>
        SessionHeader ? (
          <span key={name} data-plugin={name}>
            <PluginBoundary name={name}>
              <SessionHeader context={pluginContext(name)} session={session} />
            </PluginBoundary>
          </span>
        ) : null,
      ),
    [session, parts],
  );

  const panels = useMemo(
    () =>
      parts.map(({ name, SessionPanel }) =>
        SessionPanel ? (
          <div key={name} data-plugin={name} className="empty:hidden">
            <PluginBoundary name={name}>
              <SessionPanel context={pluginContext(name)} session={session} />
            </PluginBoundary>
          </div>
        ) : null,
      ),
    [session, parts],
  );

  return { headers, panels };
}
