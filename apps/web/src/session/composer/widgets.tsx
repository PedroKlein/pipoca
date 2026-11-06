import type { MountedSession } from "@pipoca/plugins/web";
import { memo, type ReactElement } from "react";
import { PluginBoundary } from "../../plugin-boundary";
import { fillsOf, useSessionPlugins } from "../../plugins";
import type { ShownWidget } from "../feed";
import { TerminalText } from "../terminal/terminal-text";

// Kept across renders so plugin parts re-render on their own events, not on
// every token.
export const PluginParts = memo(function Parts({
  session,
  team,
}: {
  readonly session: MountedSession;
  readonly team: boolean;
}): ReactElement[] {
  return fillsOf("session.composer", useSessionPlugins(team)).map(
    ({ plugin, Component }) => (
      <PluginBoundary key={plugin} name={plugin}>
        <Component session={session} />
      </PluginBoundary>
    ),
  );
});

// Extensions' widgets as Pi's TUI draws them (ADR 0030).
export function Widgets({
  widgets,
}: {
  readonly widgets: readonly ShownWidget[];
}): ReactElement | null {
  const lines = widgets.flatMap((widget) => widget.lines);

  return lines.length === 0 ? null : (
    <TerminalText text={lines.join("\n")} className="rounded-md bg-code py-2" />
  );
}
