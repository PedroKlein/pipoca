import { Config, kernelConfig, type ConfigKey } from "@pipoca/plugins";
import { type HubLayout, hubLayout, type Log } from "@pipoca/protocol";

export interface Hub {
  readonly layout: () => HubLayout;
  readonly lay: (layout: HubLayout) => void;
}

const hubOptions = Config.object({
  pages: { ...hubLayout.properties.pages, default: null },
});

// The hub's layout in pipoca.json, under "hub".
export function hubSettings(config: ConfigKey, log: Log): Hub {
  const read = kernelConfig(config, hubOptions, log);

  return {
    layout: () => laidOut(read()),
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
