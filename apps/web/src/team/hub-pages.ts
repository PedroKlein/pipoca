import type { HubPanel, HubScreen } from "@pipoca/plugins/web";
import type { HubPage } from "@pipoca/protocol";
import type { IconName } from "@pipoca/ui";
import { enabledPlugins } from "../plugins";

export interface Entry {
  readonly path: string;
  readonly label: string;
  readonly icon: IconName;
}

interface Placed extends HubPanel {
  readonly id: string;
  readonly plugin: string;
}

interface Screen extends HubScreen {
  readonly path: string;
  readonly plugin: string;
}

export function panels(): readonly Placed[] {
  return enabledPlugins().flatMap(({ name, hub }) =>
    Object.entries(hub?.panels ?? {}).map(([key, panel]) => ({
      ...panel,
      id: `${name}/${key}`,
      plugin: name,
    })),
  );
}

export function screens(): readonly Screen[] {
  return enabledPlugins().flatMap(({ name, hub }) =>
    Object.entries(hub?.pages ?? {}).map(([key, screen]) => ({
      ...screen,
      path: `team/plugin/${name}/${key}`,
      plugin: name,
    })),
  );
}

// Until an admin lays it out, Home shows every panel.
export function pagesOf(laid: readonly HubPage[] | null): readonly HubPage[] {
  return (
    laid ?? [
      { id: "home", title: "Home", panels: panels().map(({ id }) => id) },
    ]
  );
}

export function pathOf({ id }: HubPage): string {
  return id === "home" ? "team" : `team/page/${id}`;
}

export function newPageId(title: string, pages: readonly HubPage[]): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "page";

  let id = base;

  for (let n = 2; pages.some((page) => page.id === id); n++) {
    id = `${base}-${String(n)}`;
  }

  return id;
}
