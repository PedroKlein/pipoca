import type { Profile } from "@pipoca/protocol";
import { Icon, Picker } from "@pipoca/ui";
import type { ReactElement } from "react";
import { href } from "../../router";
import { SourceTag } from "./inherited";
import { layerHashes, layerNames, chipClass } from "./layers";

// What a Profile builds on, from the bottom: the base, the person's My
// defaults and, if they pick one, another Profile (ADR 0063).
export function BuildsOn({
  profile,
  profiles,
  value,
  team,
  disabled = false,
  onChange,
}: {
  readonly profile: Profile | undefined;
  readonly profiles: readonly Profile[];
  readonly value: string | null;
  readonly team: boolean;
  readonly disabled?: boolean;
  readonly onChange: (id: string | null) => void;
}): ReactElement {
  const shared = profile?.ownerId === null;

  const options = profiles.filter(
    ({ id, ownerId }) => id !== profile?.id && (!shared || ownerId === null),
  );

  const step = <Icon name="chevron-right" className="size-3.5 text-fg-dim" />;

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-label">
      <span className="mr-1 text-fg-dim">Builds on</span>
      <a
        href={href("settings", { page: "profiles", rest: layerHashes.base })}
        className="rounded-md hover:opacity-80"
      >
        <SourceTag name={layerNames.base} kind="base" />
      </a>
      {step}
      {!team && (
        <>
          <a
            href={href("settings", {
              page: "profiles",
              rest: layerHashes.defaults,
            })}
            className="rounded-md hover:opacity-80"
          >
            <SourceTag name={layerNames.defaults} kind="defaults" />
          </a>
          {step}
        </>
      )}
      {disabled ? (
        <span className={chipClass}>
          {profiles.find(({ id }) => id === value)?.name ?? "Nothing else"}
        </span>
      ) : (
        <Picker
          label="Builds on"
          options={[
            { value: "", label: "Nothing else" },
            ...options.map(({ id, name }) => ({ value: id, label: name })),
          ]}
          selected={[value ?? ""]}
          onChange={([id]) => {
            onChange(id === undefined || id === "" ? null : id);
          }}
        >
          {profiles.find(({ id }) => id === value)?.name ?? "Nothing else"}
        </Picker>
      )}
      {profile && (
        <>
          {step}
          <SourceTag name={profile.name} kind="own" />
        </>
      )}
    </div>
  );
}
