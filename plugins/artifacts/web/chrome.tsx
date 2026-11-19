import { ago } from "@pipoca/plugins/web";
import type { MenuItem } from "@pipoca/ui";
import {
  type ArtifactSummary,
  type ArtifactView,
  type Version,
  versionOf,
} from "../src/artifacts";

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

// Its versions as a menu, newest first, with the one shown checked. A
// living doc lists its versions, then its edits by person and hour.
export function versionChoices(
  artifact: ArtifactView,
  now: number,
  shown: number,
  choose: (version: number) => void,
  offered: (version: number) => boolean = () => true,
): MenuItem[] {
  const pick = (number: number) => () => {
    choose(number);
  };

  if (!artifact.living) {
    return [...artifact.history]
      .reverse()
      .filter((each) => offered(each.number))
      .map((each) => ({
        label: `Version ${String(each.number)}`,
        ...(each.number === artifact.versions && { badge: "latest" }),
        description: byline(each, now),
        checked: each.number === shown,
        run: pick(each.number),
      }));
  }

  const named = [...artifact.history]
    .reverse()
    .filter((each) => each.label !== null && offered(each.number))
    .map((each) => ({
      label: `Version ${String(versionOf(artifact, each.number))}`,
      ...(each.number === artifact.versions && { badge: "latest" }),
      description: `${String(each.label)} · ${ago(new Date(each.createdAt).toISOString(), now)}`,
      checked: each.number === shown,
      run: pick(each.number),
    }));

  const edits = editGroups(artifact.history)
    .reverse()
    .flatMap((group) => {
      const last = group.at(-1);

      return last !== undefined && offered(last.number)
        ? [{ last, count: group.length }]
        : [];
    })
    .map(({ last, count }, at): MenuItem => {
      return {
        label: `Edited by ${last.by}`,
        ...(last.number === artifact.versions && { badge: "latest" }),
        description: [
          ago(new Date(last.createdAt).toISOString(), now),
          ...(count > 1 ? [`${String(count)} edits`] : []),
        ].join(" · "),
        checked: last.number === shown,
        divided: at === 0 && named.length > 0,
        run: pick(last.number),
      };
    });

  return [...named, ...edits];
}

const hour = 60 * 60 * 1000;

// A living doc's saves in runs by one person within an hour, oldest first.
function editGroups(history: readonly Version[]): Version[][] {
  const groups: Version[][] = [];

  for (const each of history) {
    const group = groups.at(-1);
    const first = group?.[0];

    if (
      first?.author === each.author &&
      each.createdAt - first.createdAt < hour
    ) {
      group?.push(each);
    } else {
      groups.push([each]);
    }
  }

  return groups;
}

// What the header says is open.
export function shownLine(
  artifact: ArtifactView,
  shown: number,
  now: number,
): string {
  const latest = shown === artifact.versions;

  if (!artifact.living) {
    return latest
      ? `Version ${String(shown)} · latest`
      : `Version ${String(shown)} of ${String(artifact.versions)}`;
  }

  const number = versionOf(artifact, shown);
  const save = artifact.history[shown - 1];

  if (latest) {
    return number === null ? "Latest" : `Version ${String(number)} · latest`;
  }

  return number === null
    ? `Edit · ${save === undefined ? "" : ago(new Date(save.createdAt).toISOString(), now)}`
    : `Version ${String(number)}`;
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
