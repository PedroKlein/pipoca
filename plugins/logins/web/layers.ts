import type { Profile } from "@pipoca/protocol";
import type { LoginLayer } from "../src/model";

export function layerName(
  layer: LoginLayer,
  profiles: readonly Profile[],
): string {
  if (layer === "base") {
    return "Server base";
  }

  if (layer === "defaults") {
    return "My defaults";
  }

  const id = layer.slice("profile:".length);

  return profiles.find((profile) => profile.id === id)?.name ?? id;
}
