import type { PageProps } from "@pipoca/plugins/web";
import type { HubPage } from "@pipoca/protocol";
import type { IconName } from "@pipoca/ui";
import type { ComponentType } from "react";
import { enabledPlugins } from "../plugins";
import { href } from "../router";

export interface Entry {
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
  readonly count?: number;
}

interface Placed {
  readonly id: string;
  readonly plugin: string;
  readonly title: string;
  readonly Panel: ComponentType;
}

interface Screen {
  readonly href: string;
  readonly plugin: string;
  readonly label: string;
  readonly Page: ComponentType<PageProps>;
}

export function panels(): readonly Placed[] {
  return enabledPlugins().flatMap(({ plugin: { id }, panels: placed }) =>
    Object.entries(placed ?? {}).map(([key, panel]) => ({
      ...panel,
      id: `${id}/${key}`,
      plugin: id,
    })),
  );
}

export function screens(): readonly Screen[] {
  return enabledPlugins().flatMap(({ plugin: { id }, pages }) =>
    (pages ?? []).flatMap(({ area, path, label, Page }) =>
      area === "hub"
        ? [
            {
              href: href("teamPlugin", { plugin: id, key: path }),
              plugin: id,
              label,
              Page,
            },
          ]
        : [],
    ),
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

export function hrefOf({ id }: HubPage): string {
  return id === "home" ? href("team") : href("teamPage", { id });
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
