import { ago } from "@pipoca/plugins/web";
import type { MenuItem } from "@pipoca/ui";
import type { ArtifactSummary, ArtifactView, Version } from "../src/artifacts";

// Who made a version, when, and what it changed. Pi's label is its own
// words, so it's quoted.
export function byline(version: Version, now: number): string {
  return [
    version.by,
    ago(new Date(version.createdAt).toISOString(), now),
    ...(version.note === ""
      ? []
      : [
          version.author.startsWith("session:")
            ? `“${version.note}”`
            : version.note,
        ]),
  ].join(" · ");
}

// Its versions as a menu, newest first, with the one shown checked.
export function versionChoices(
  artifact: ArtifactView,
  now: number,
  shown: number,
  choose: (version: number) => void,
  offered: (version: number) => boolean = () => true,
): MenuItem[] {
  return [...artifact.history]
    .reverse()
    .filter((each) => offered(each.number))
    .map((each) => ({
      label: `Version ${String(each.number)}`,
      ...(each.number === artifact.versions && { badge: "latest" }),
      description: byline(each, now),
      checked: each.number === shown,
      run: () => {
        choose(each.number);
      },
    }));
}

export function audienceLabel(artifact: ArtifactSummary): string {
  if (artifact.audience === "team") {
    return "Team";
  }

  if (artifact.audience === "named") {
    return `Shared with ${artifact.sharedWith.join(", ")}`;
  }

  return artifact.yours ? "Only you" : `From ${artifact.owner}`;
}
