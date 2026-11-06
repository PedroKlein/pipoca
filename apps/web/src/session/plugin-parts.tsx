import type { MountedSession } from "@pipoca/plugins/web";
import { type ReactNode, useMemo } from "react";
import { PluginBoundary } from "../plugin-boundary";
import { useSessionPlugins } from "../plugins";

// Kept across renders so plugin parts re-render on their own events, not on
// every token.
export function usePluginHeaders(
  team: boolean,
  session: MountedSession,
): ReactNode {
  const parts = useSessionPlugins(team);

  return useMemo(
    () =>
      parts.map(({ name, SessionHeader }) =>
        SessionHeader ? (
          <span key={name} data-plugin={name}>
            <PluginBoundary name={name}>
              <SessionHeader session={session} />
            </PluginBoundary>
          </span>
        ) : null,
      ),
    [session, parts],
  );
}
