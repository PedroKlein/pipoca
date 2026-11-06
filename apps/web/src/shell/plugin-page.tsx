import type { WebPage } from "@pipoca/plugins/web";
import { Button, Icon, Page } from "@pipoca/ui";
import { createElement, type ReactElement } from "react";
import { ShellMenu } from "../session/embedded-session";
import { PluginBoundary } from "../plugin-boundary";
import { ownPages, pageFills } from "../plugins";

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

  if (pageFills(name, path)) {
    return (
      <ShellMenu value={onMenu}>
        <div
          id="plugin-page"
          data-plugin={name}
          className="flex min-h-0 min-w-0 flex-1"
        >
          {body}
        </div>
      </ShellMenu>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="p-2 md:hidden">
        <MenuButton onMenu={onMenu} />
      </div>
      <Page id="plugin-page">{body}</Page>
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
  const page = [...pages]
    .sort((one, other) => other.path.length - one.path.length)
    .find(
      (each) =>
        each.path === "" ||
        path === each.path ||
        path.startsWith(`${each.path}/`),
    );

  return page
    ? createElement(page.Page, {
        path: page.path === "" ? path : path.slice(page.path.length + 1),
      })
    : null;
}
