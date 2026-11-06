import type { ReactElement } from "react";
import { PluginBoundary } from "../plugin-boundary";
import { fillsOf } from "../plugins";

type Slot =
  | { readonly slot: "General" | "Accounts" }
  | { readonly slot: "Profile"; readonly profileId: string };

const slotNames = {
  General: "settings.general",
  Accounts: "settings.accounts",
} as const;

// What plugins add to a Settings page, each inside its own boundary
// (ADR 0063).
export function SettingsSlot(props: Slot): ReactElement {
  const parts =
    props.slot === "Profile"
      ? fillsOf("settings.profile").map(({ plugin, Component }) => ({
          plugin,
          part: <Component profileId={props.profileId} />,
        }))
      : fillsOf(slotNames[props.slot]).map(({ plugin, Component }) => ({
          plugin,
          part: <Component />,
        }));

  return (
    <>
      {parts.map(({ plugin, part }) => (
        <PluginBoundary key={plugin} name={plugin}>
          {part}
        </PluginBoundary>
      ))}
    </>
  );
}

export function hasSettingsParts(slot: "General" | "Accounts"): boolean {
  return fillsOf(slotNames[slot]).length > 0;
}
