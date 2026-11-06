import type { MountedSession } from "@pipoca/plugins/web";
import { type ReactNode, useMemo } from "react";
import { PluginBoundary } from "../plugin-boundary";
import { fillsOf, useSessionPlugins } from "../plugins";

// Kept across renders so plugin parts re-render on their own events, not on
// every token.
export function usePluginHeaders(
  team: boolean,
  session: MountedSession,
): ReactNode {
  const parts = useSessionPlugins(team);

  return useMemo(
    () =>
      fillsOf("session.header", parts).map(({ plugin, Component }) => (
        <span key={plugin} data-plugin={plugin}>
          <PluginBoundary name={plugin}>
            <Component session={session} />
          </PluginBoundary>
        </span>
      )),
    [session, parts],
  );
}
