import type { NavItemsProps, PageProps } from "@pipoca/plugins/web";
import type { HubPage } from "@pipoca/protocol";
import type { IconName } from "@pipoca/ui";
import type { ComponentType } from "react";
import { request } from "../data/client";
import { useAction, useQuery } from "../data/hooks";
import { enabledPlugins } from "../plugins";
import { href, navigate } from "../router";

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
  readonly key: string;
  readonly label: string;
  readonly icon: IconName;
  readonly Page: ComponentType<PageProps>;
  readonly Items: ComponentType<NavItemsProps> | undefined;
  readonly Count: ComponentType | undefined;
  readonly fills: ((path: string) => boolean) | undefined;
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
    (pages ?? []).flatMap(({ area, path, label, icon, Page, nav }) =>
      area === "hub"
        ? [
            {
              href: href("teamPlugin", { plugin: id, key: path }),
              plugin: id,
              key: path,
              label,
              icon: icon ?? "panel-right",
              Page,
              Items: nav?.Live,
              Count: nav?.Count,
              fills: nav?.fills,
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

// The hub's pages and an admin's changes to them, from the hub or from
// Team setup alike.
export function useHubPages(): {
  readonly pages: readonly HubPage[];
  readonly error: string | undefined;
  // Adds an empty page and opens it.
  readonly add: (title: string) => void;
  readonly change: (page: HubPage) => void;
  readonly remove: (id: string) => void;
  readonly move: (from: number, to: number) => void;
} {
  const pages = pagesOf(useQuery("settings.hub").data?.pages ?? null);

  const lay = useAction(async (next: readonly HubPage[]) =>
    request("settings.hub.update", { body: { pages: next } }),
  );

  return {
    pages,
    error: lay.error,
    add: (title) => {
      const page = { id: newPageId(title, pages), title, panels: [] };

      void lay.run([...pages, page]);
      navigate(hrefOf(page));
    },
    change: (page) => {
      void lay.run(pages.map((each) => (each.id === page.id ? page : each)));
    },
    remove: (id) => {
      void lay.run(pages.filter((each) => each.id !== id));
    },
    move: (from, to) => {
      const next = [...pages];
      const [page] = next.splice(from, 1);

      if (page !== undefined) {
        next.splice(to, 0, page);
        void lay.run(next);
      }
    },
  };
}

function newPageId(title: string, pages: readonly HubPage[]): string {
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
