import type { WebPage } from "@pipoca/plugins/web";
import { Button, Icon, Page } from "@pipoca/ui";
import { createElement, type ReactElement, type ReactNode } from "react";
import { ShellMenu } from "../session/embedded-session";
import { PluginBoundary } from "../plugin-boundary";
import { guarded, ownPages, pageFills } from "../plugins";

export function MenuButton({
  onMenu,
}: {
  readonly onMenu: () => void;
}): ReactElement {
  return (
    <Button
      variant="ghost"
      iconOnly
      aria-label="Open sessions"
      onClick={onMenu}
      className="md:hidden"
    >
      <Icon name="menu" />
    </Button>
  );
}

export function PluginPage({
  name,
  path,
  onMenu,
}: {
  readonly name: string;
  readonly path: string;
  readonly onMenu: () => void;
}): ReactElement {
  const pages = ownPages(name);

  const body =
    pages.length > 0 ? (
      <PluginBoundary key={name} name={name}>
        <PageAt pages={pages} path={path} />
      </PluginBoundary>
    ) : (
      <p className="text-fg-dim">This page isn&apos;t available.</p>
    );

  return (
    <PluginFrame plugin={name} fills={pageFills(name, path)} onMenu={onMenu}>
      {body}
    </PluginFrame>
  );
}

// Where a plugin's page sits in either workspace: filling the main column
// and scrolling itself, such as a Project, or in a scrolling page column.
export function PluginFrame({
  plugin,
  fills,
  onMenu,
  children,
}: {
  readonly plugin: string;
  readonly fills: boolean;
  readonly onMenu: () => void;
  readonly children: ReactNode;
}): ReactElement {
  if (fills) {
    return (
      <ShellMenu value={onMenu}>
        <div
          id="plugin-page"
          data-plugin={plugin}
          className="flex min-h-0 min-w-0 flex-1"
        >
          {children}
        </div>
      </ShellMenu>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="p-2 md:hidden">
        <MenuButton onMenu={onMenu} />
      </div>
      <Page id="plugin-page">{children}</Page>
    </div>
  );
}

// The page whose path is the longest start of the address, given the rest.
function PageAt({
  pages,
  path,
}: {
  readonly pages: readonly WebPage[];
  readonly path: string;
}): ReactElement | null {
  const found = pageAt(pages, path);

  return found ? createElement(found.page.Page, { path: found.rest }) : null;
}

function pageAt(
  pages: readonly WebPage[],
  path: string,
): { readonly page: WebPage; readonly rest: string } | undefined {
  const page = [...pages]
    .sort((one, other) => other.path.length - one.path.length)
    .find(
      (each) =>
        each.path === "" ||
        path === each.path ||
        path.startsWith(`${each.path}/`),
    );

  return page
    ? {
        page,
        rest: page.path === "" ? path : path.slice(page.path.length + 1),
      }
    : undefined;
}

// Whether the address opens a page drawn alone in the window.
export function isBare(name: string, path: string): boolean {
  const found = pageAt(ownPages(name), path);

  return (
    found !== undefined && guarded(() => found.page.bare?.(found.rest)) === true
  );
}
