import { Avatar, Icon, Menu } from "@pipoca/ui";
import type { ReactElement } from "react";
import { request } from "../data/client";
import { href, navigate } from "../router";

// Settings and signing out, behind the user's name like Claude Code's account
// menu (ADR 0040).
export function AccountMenu({ user }: { readonly user: string }): ReactElement {
  return (
    <Menu
      label="Account"
      side="above"
      align="stretch"
      className="border-t border-line p-2"
      triggerClassName="w-full justify-start text-label text-fg"
      trigger={
        <>
          <Avatar name={user} size="xs" className="bg-accent-tint text-accent">
            {user.slice(0, 1).toUpperCase()}
          </Avatar>
          <span className="flex-1 truncate text-left">{user}</span>
          <Icon name="settings" className="text-fg-dim" />
        </>
      }
      items={[
        {
          label: "Settings",
          icon: "settings",
          run: () => {
            navigate(href("settings"));
          },
        },
        {
          label: "Sign out",
          divided: true,
          run: () => {
            void request("auth.session.remove").finally(() => {
              location.replace("/");
            });
          },
        },
      ]}
    />
  );
}

// Plugin pages show in the sidebar when pinned, and the rest under More, like
// Claude Code's sidebar (ADR 0040). Someone who never changed their pins has
// the ones the plugins pin.
