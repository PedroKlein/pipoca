import type { Profile, ProfileContent } from "@pipoca/protocol";
import { Badge, cn, initialsOf, plural } from "@pipoca/ui";
import type { ReactElement, ReactNode } from "react";
import { request } from "../../data/client";
import { useMe, useQuery } from "../../data/hooks";
import { SettingsSlot } from "../settings-slot";
import { href, scopedHref } from "../../router";
import { layerFolder, profileFolder } from "./folder";
import {
  type Layer,
  layerAbout,
  layerMarks,
  layerHashes,
  layerNames,
  layerRoutes,
} from "./layers";
import { type BelowLayer, ProfileOverview } from "./overview";
import { chainOf } from "./overview-values";

// The Server base and, for a person's own work, their My defaults.
function useLayersBelow(withDefaults: boolean): readonly BelowLayer[] {
  const base = useQuery(layerRoutes.base).data;

  const defaults = useQuery(layerRoutes.defaults, undefined, {
    enabled: withDefaults,
  }).data;

  return [
    ...(base ? [layerBelow("base", base)] : []),
    ...(withDefaults && defaults ? [layerBelow("defaults", defaults)] : []),
  ];
}

function layerBelow(layer: Layer, content: ProfileContent): BelowLayer {
  return {
    id: layerHashes[layer],
    name: layerNames[layer],
    kind: layer,
    folder: layerFolder(layer),
    href: href("settings", { page: "profiles", rest: layerHashes[layer] }),
    content,
  };
}

export function ProfileOverviewOf({
  profile,
  profiles,
  editable,
  buildsOn,
  children,
}: {
  readonly profile: Profile;
  readonly profiles: readonly Profile[];
  readonly editable: boolean;
  readonly buildsOn: ReactNode;
  readonly children?: ReactNode;
}): ReactElement {
  const team = profile.ownerId === "team";
  const layers = useLayersBelow(!team);

  const chain = chainOf(profile, profiles)
    .toReversed()
    .map((under) => ({
      id: under.id,
      name: under.name,
      kind: "profile" as const,
      folder: profileFolder(under.id),
      href: scopedHref(under.ownerId === "team", "profiles", under.id),
      content: under,
    }));

  return (
    <ProfileOverview
      target={{
        id: profile.id,
        name: profile.name,
        folder: profileFolder(profile.id),
        content: profile,
        editable,
        tab: (name) => scopedHref(team, "profiles", `${profile.id}/${name}`),
        save: async (body) =>
          request("profiles.update", { params: { id: profile.id }, body }),
        preview: true,
      }}
      below={[...layers, ...chain]}
      buildsOn={buildsOn}
    >
      {children}
    </ProfileOverview>
  );
}

// The Server base or My defaults, with the same page as a Profile
// (ADR 0074). Only admins change the Server base.
export function LayerOverview({
  layer,
}: {
  readonly layer: Layer;
}): ReactElement | null {
  const { admin } = useMe();
  const content = useQuery(layerRoutes[layer]).data;
  const below = useLayersBelow(false).filter(() => layer === "defaults");

  if (!content) {
    return null;
  }

  return (
    <>
      <ProfileOverview
        target={{
          id: layerHashes[layer],
          name: layerNames[layer],
          folder: layerFolder(layer),
          content,
          editable: layer === "defaults" || admin,
          tab: (name) =>
            href("settings", {
              page: "profiles",
              rest: `${layerHashes[layer]}/${name}`,
            }),
          save: async (body) =>
            request(`${layerRoutes[layer]}.update`, { body }),
        }}
        below={below}
        header={<LayerHeader layer={layer} />}
      />
      {layer === "base" && <SettingsSlot slot="Server base" />}
    </>
  );
}

// Who a layer reaches, at the top of its page.
function LayerHeader({ layer }: { readonly layer: Layer }): ReactElement {
  const { admin } = useMe();
  const base = layer === "base";
  const people = useQuery("people.list", undefined, { enabled: base }).data;

  const team = useQuery(
    "profiles.list",
    { query: { scope: "team" } },
    { enabled: base },
  ).data;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-4 rounded-xl border border-line bg-elevated p-4">
      <span
        aria-hidden="true"
        className={cn(
          "grid size-11 shrink-0 place-items-center rounded-lg font-semibold",
          layerMarks[layer],
        )}
      >
        {initialsOf(layerNames[layer])}
      </span>
      <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-1">
        <span className="text-ui font-medium text-fg-strong">
          {layerNames[layer]}
        </span>
        <span className="text-label text-fg-dim">
          {layerAbout[layer]}
          {base && !admin && " Only admins change it."}
        </span>
      </div>
      {base && (
        <span className="flex flex-wrap gap-1.5">
          {people && (
            <Badge state="offline">
              {plural(people.length, "person", "people")}
            </Badge>
          )}
          {team && (
            <Badge state="offline">{plural(team.length, "team Profile")}</Badge>
          )}
        </span>
      )}
    </div>
  );
}
