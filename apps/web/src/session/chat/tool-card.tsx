import type { MountedSession } from "@pipoca/plugins/web";
import type { UiAction } from "@pipoca/protocol";
import type { ReactElement } from "react";
import { PluginBoundary } from "../../plugin-boundary";
import { pluginContext, toolRenderer } from "../../plugins";
import { addressHref } from "../../router";
import { openedOf, type Step } from "./chat";

export const claimed = (tool: string): boolean =>
  toolRenderer(tool) !== undefined;

function OpenedCard({ opened }: { readonly opened: UiAction }): ReactElement {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-ui text-fg">
        {opened.label}
      </span>
      <a
        href={addressHref(opened.route)}
        className="inline-flex h-control items-center rounded-md border border-line bg-elevated px-3 text-ui font-medium text-fg hover:border-line-strong hover:bg-hover pointer-coarse:min-h-touch"
      >
        Open
      </a>
    </div>
  );
}

// A tool call drawn by the plugin that claims its tool (ADR 0030), or the
// card for what it opened (ADR 0052).
export function ToolCard({
  step,
  session,
}: {
  readonly step: Step;
  readonly session: MountedSession;
}): ReactElement | null {
  const renderer = toolRenderer(step.name);

  if (!renderer) {
    const opened = openedOf(step.result?.details);

    return opened ? <OpenedCard opened={opened} /> : null;
  }

  const { plugin, Component } = renderer;

  const status = step.result?.failed === true ? "failed" : "done";

  return (
    <PluginBoundary name={plugin}>
      <Component
        context={pluginContext(plugin)}
        session={session}
        call={{
          id: step.id,
          name: step.name,
          args: step.args,
          status: step.result ? status : "running",
          ...(step.result && {
            result: {
              text: step.result.text,
              details: step.result.details,
              failed: step.result.failed,
            },
          }),
        }}
      />
    </PluginBoundary>
  );
}
