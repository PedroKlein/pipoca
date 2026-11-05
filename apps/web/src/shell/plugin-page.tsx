import { Button, Icon } from "@pipoca/ui";
import type { ReactElement } from "react";
import { ShellMenu } from "../embedded-session";
import { PluginBoundary } from "../plugin-boundary";
import { enabledPlugins, pageFills, pluginContext } from "../plugins";

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
  const Page = enabledPlugins().find((plugin) => plugin.name === name)?.nav
    ?.Page;

  const body = Page ? (
    <PluginBoundary key={name} name={name}>
      <Page context={pluginContext(name)} path={path} />
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
      <div
        id="plugin-page"
        data-plugin={name}
        className="mx-auto flex w-full max-w-form flex-col px-4 py-10 md:px-10"
      >
        {body}
      </div>
    </div>
  );
}
