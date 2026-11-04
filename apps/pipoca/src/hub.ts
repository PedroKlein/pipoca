import { BadRequest, fieldsOf, type PluginConfig } from "@pipoca/plugins";
import type { HubLayout, HubPage } from "@pipoca/protocol";
import { listOf, textOf } from "./requests";

const pageId = /^[a-z0-9][a-z0-9-]{0,39}$/;
const panelName = /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_-]*$/;
const maxPages = 20;
const maxPanels = 30;

export interface Hub {
  readonly layout: () => HubLayout;
  readonly lay: (layout: HubLayout) => void;
}

// The hub's layout in pipoca.json, under "hub".
export function hubLayout(config: PluginConfig): Hub {
  return {
    layout: () => {
      try {
        return layoutOf(config.get() ?? { pages: null });
      } catch {
        return { pages: null };
      }
    },
    lay: (layout) => {
      config.set(layout);
    },
  };
}

export function layoutOf(value: unknown): HubLayout {
  const { pages } = fieldsOf(value);

  if (pages === null) {
    return { pages };
  }

  const listed = listOf("pages", pages, pageOf);
  const ids = new Set(listed.map(({ id }) => id));

  if (listed.length > maxPages) {
    throw new BadRequest(`the hub has at most ${String(maxPages)} pages`);
  }

  if (ids.size !== listed.length) {
    throw new BadRequest("each hub page needs its own id");
  }

  if (listed[0]?.id !== "home") {
    throw new BadRequest('the first hub page must be "home"');
  }

  return { pages: listed };
}

function pageOf(value: unknown): HubPage {
  const { id, title, panels } = fieldsOf(value);
  const named = textOf("id", id);
  const titled = textOf("title", title).trim();

  if (!pageId.test(named)) {
    throw new BadRequest(
      "a hub page id is 1 to 40 lowercase letters, digits or dashes",
    );
  }

  if (titled === "" || titled.length > 60) {
    throw new BadRequest("a hub page title is 1 to 60 characters");
  }

  const placed = listOf("panels", panels, (panel) => {
    const text = textOf("panel", panel);

    if (!panelName.test(text)) {
      throw new BadRequest('a panel is named "<plugin>/<panel>"');
    }

    return text;
  });

  if (placed.length > maxPanels) {
    throw new BadRequest(`a hub page has at most ${String(maxPanels)} panels`);
  }

  return { id: named, title: titled, panels: placed };
}
