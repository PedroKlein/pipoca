import type { ReactElement, ReactNode } from "react";
import { PluginBoundary } from "../plugin-boundary";
import { enabledPlugins } from "../plugins";

type Slot =
  | { readonly slot: "General" | "Accounts" }
  | { readonly slot: "Profile"; readonly profileId: string };

// What plugins add to a Settings page, each inside its own boundary
// (ADR 0063).
export function SettingsSlot(props: Slot): ReactElement {
  return (
    <>
      {enabledPlugins().map(({ name, settingsParts }) => {
        let part: ReactNode;

        if (props.slot === "Profile") {
          const Part = settingsParts?.Profile;

          part = Part && (
            <Part profileId={props.profileId} />
          );
        } else {
          const Part = settingsParts?.[props.slot];

          part = Part && <Part />;
        }

        return (
          part && (
            <PluginBoundary key={name} name={name}>
              {part}
            </PluginBoundary>
          )
        );
      })}
    </>
  );
}

export function hasSettingsParts(slot: "General" | "Accounts"): boolean {
  return enabledPlugins().some(
    ({ settingsParts }) => settingsParts?.[slot] !== undefined,
  );
}
