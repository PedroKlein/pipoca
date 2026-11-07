import type { Profile, ProfileContent } from "@pipoca/protocol";
import { Notice } from "@pipoca/ui";
import type { ReactElement, ReactNode } from "react";
import { request } from "../../data/client";
import { useMe, useQuery } from "../../data/hooks";
import { href, scopedHref } from "../../router";
import { layerFolder, profileFolder } from "./folder";
import {
  type Layer,
  layerAbout,
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
    content,
  };
}

export function ProfileOverviewOf({
  profile,
  profiles,
  editable,
  children,
}: {
  readonly profile: Profile;
  readonly profiles: readonly Profile[];
  readonly editable: boolean;
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
      <Notice className="mt-4">{layerAbout[layer]}</Notice>
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
      />
    </>
  );
}
