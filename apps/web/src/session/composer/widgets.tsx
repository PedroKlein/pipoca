import type { MountedSession } from "@pipoca/plugins/web";
import { memo, type ReactElement } from "react";
import { PluginBoundary } from "../../plugin-boundary";
import {
  pluginContext,
  useSessionPlugins,
  widgetRenderer,
} from "../../plugins";
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
  return useSessionPlugins(team).flatMap(({ name, Composer: Part }) =>
    Part
      ? [
          <PluginBoundary key={name} name={name}>
            <Part context={pluginContext(name)} session={session} />
          </PluginBoundary>,
        ]
      : [],
  );
});

// Extensions' widgets as Pi's TUI draws them, one box for each run of
// widgets no plugin claims (ADR 0030).
export function Widgets({
  widgets,
  session,
}: {
  readonly widgets: readonly ShownWidget[];
  readonly session: MountedSession;
}): ReactElement[] {
  const shown: ReactElement[] = [];
  let lines: string[] = [];

  const box = (): void => {
    if (lines.length > 0) {
      shown.push(
        <TerminalText
          key={`text-${String(shown.length)}`}
          text={lines.join("\n")}
          className="rounded-md bg-code py-2"
        />,
      );

      lines = [];
    }
  };

  for (const widget of widgets) {
    const renderer = widgetRenderer(widget.key);

    if (!renderer) {
      lines.push(...widget.lines);

      continue;
    }

    box();

    const { plugin, Component } = renderer;

    shown.push(
      <PluginBoundary key={widget.key} name={plugin}>
        <Component
          context={pluginContext(plugin)}
          session={session}
          lines={widget.lines}
        />
      </PluginBoundary>,
    );
  }

  box();

  return shown;
}
