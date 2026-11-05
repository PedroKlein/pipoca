import type { PluginConfig } from "@pipoca/plugins";
import { type HubLayout, hubLayout } from "@pipoca/protocol";
import { Value } from "typebox/value";

export interface Hub {
  readonly layout: () => HubLayout;
  readonly lay: (layout: HubLayout) => void;
}

// The hub's layout in pipoca.json, under "hub".
export function hubSettings(config: PluginConfig): Hub {
  return {
    layout: () => {
      const value = config.get() ?? { pages: null };

      return Value.Check(hubLayout, value) ? laidOut(value) : { pages: null };
    },
    lay: (layout) => {
      config.set(layout);
    },
  };
}

export function laidOut({ pages }: HubLayout): HubLayout {
  return {
    pages:
      pages?.map(({ id, title, panels }) => ({
        id,
        title: title.trim(),
        panels,
      })) ?? null,
  };
}
