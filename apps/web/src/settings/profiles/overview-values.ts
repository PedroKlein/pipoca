import type { Profile } from "@pipoca/protocol";
import type { Folder } from "./folder";
import type { Skill } from "./overview-parts";

export async function skillsIn(
  folder: Folder,
  from?: string,
): Promise<readonly Skill[]> {
  const entries = await folder.list().catch(() => []);

  return Promise.all(
    entries
      .filter(({ path }) => /^skills\/(.+\/)?[^/]+\/SKILL\.md$/.test(path))
      .map(async ({ path }) => skillOf(path, await folder.read(path), from)),
  );
}

function skillOf(path: string, text: string, from: string | undefined): Skill {
  const field = (key: string): string | undefined =>
    new RegExp(`^${key}:\\s*(.+)$`, "m").exec(
      /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "",
    )?.[1];

  const folder = path.replace(/\/SKILL\.md$/, "");

  return {
    folder,
    name: field("name") ?? folder.split("/").at(-1) ?? path,
    description: field("description") ?? "",
    ...(from !== undefined && { from }),
  };
}

// Pi leaves out a skill its settings list as "-<folder>".
export function offSkills(settings: Profile["settings"]): ReadonlySet<string> {
  const skills = settings["skills"];

  return new Set(
    Array.isArray(skills)
      ? skills.flatMap((entry: unknown) =>
          typeof entry === "string" && entry.startsWith("-")
            ? [entry.slice(1)]
            : [],
        )
      : [],
  );
}

export function withSkill(
  settings: Profile["settings"],
  folder: string,
  on: boolean,
): Profile["settings"] {
  const { skills, ...rest } = settings;

  const kept = (Array.isArray(skills) ? (skills as unknown[]) : []).filter(
    (entry) =>
      typeof entry !== "string" || entry.replace(/^[-+!]/, "") !== folder,
  );

  const next = on ? kept : [...kept, `-${folder}`];

  return next.length === 0 ? rest : { ...rest, skills: next };
}

// The Profiles this one builds on, nearest first.
export function chainOf(
  profile: Profile,
  profiles: readonly Profile[],
): readonly Profile[] {
  const found: Profile[] = [];

  for (
    let next = profiles.find(({ id }) => id === profile.buildsOn);
    next !== undefined && next.id !== profile.id && !found.includes(next);
    next = profiles.find(({ id }) => id === next.buildsOn)
  ) {
    found.push(next);
  }

  return found;
}

export function serverOf(config: unknown): string {
  const { url, command, args } = (config ?? {}) as Record<string, unknown>;

  if (typeof url === "string") {
    return URL.parse(url)?.host ?? url;
  }

  return [command, ...(Array.isArray(args) ? (args as unknown[]) : [])]
    .filter((part) => typeof part === "string")
    .join(" ");
}
