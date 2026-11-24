import type { ArtifactType } from "./artifacts";

// A design system (ADR 0085): the colours, type and spacing its tokens.json
// gives, as the viewer draws them.
export interface SystemColor {
  readonly name: string;
  readonly value: string;
  readonly usage: string;
}

export interface SystemStyle {
  readonly name: string;
  readonly family: string;
  readonly size: string;
  readonly lineHeight: string;
  readonly weight: string;
  readonly letterSpacing: string;
  readonly sample: string;
  readonly usage: string;
}

export interface SystemSpace {
  readonly name: string;
  readonly value: string;
  readonly usage: string;
}

export interface SystemTokens {
  readonly colors: readonly SystemColor[];
  readonly type: readonly SystemStyle[];
  readonly spacing: readonly SystemSpace[];
}

// Built in ships with Pipoca; mine is the person's, team is team work's,
// and shared is someone else's they see.
export type SystemScope = "builtin" | "mine" | "team" | "shared";

export interface SystemSummary {
  readonly id: string;
  readonly name: string;
  readonly scope: SystemScope;
  readonly by: string;
  readonly version: number;
  readonly usedBy: number;
  readonly thumb: { readonly ground: string; readonly ink: string };
}

// What Pi does when no one picked a system for a Session.
export const unpickedChoices = ["default", "ask", "none"] as const;

export type Unpicked = (typeof unpickedChoices)[number];

export interface Systems {
  readonly systems: readonly SystemSummary[];
  // The server's default, Pipoca's own until an admin picks one.
  readonly server: string;
  readonly mine: string | null;
  readonly unpicked: Unpicked;
  // With a Session, what it picked: a system, none, or null for nothing.
  readonly session?: string | null;
}

export interface SystemComponent {
  readonly name: string;
  readonly file: string;
}

export interface SystemView extends SystemSummary {
  readonly tokens: SystemTokens;
  readonly problems: readonly string[];
  readonly components: readonly SystemComponent[];
  readonly files: number;
  readonly users: readonly {
    readonly id: string;
    readonly title: string;
    readonly type: ArtifactType;
    readonly version: number;
  }[];
  readonly server: boolean;
  readonly mine: boolean;
}

// On an artifact made with a system: the copy it keeps, and what the
// newest version changed, null when it's the copy or unseen.
export interface UsedSystem {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly latest: number | null;
  readonly changed: readonly string[];
}

export const builtInSystem = "pipoca";

// list_design_systems gives at most this many at once.
export const shownSystems = 20;

// Where an artifact keeps its copy, and the file that says which it is.
export const systemFolder = "design-system";

export const systemRecord = `${systemFolder}/system.json`;

// Keys of a section that hold no token themselves.
const sectionKeys = new Set([
  "tokens",
  "themes",
  "families",
  "groups",
  "fonts",
]);

const most = { colors: 200, type: 100, spacing: 100, components: 100 };

const shown = /^[\w\s#%(),./+-]{1,120}$/;
const family = /^[\w\s"',.-]{1,200}$/;

// What tokens.json says, read leniently: lists or maps, a value per theme,
// and {name} references. What it can't read is named, and left out.
export function tokensOf(text: string): {
  readonly tokens: SystemTokens;
  readonly problems: readonly string[];
} {
  const problems: string[] = [];
  let read: unknown;

  try {
    read = JSON.parse(text);
  } catch (error) {
    return {
      tokens: { colors: [], type: [], spacing: [] },
      problems: [
        `tokens.json isn't JSON: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  const top = record(read) ?? {};
  const colorSection = top["color"] ?? top["colors"];
  const typeSection = top["type"] ?? top["typography"];
  const spaceSection = top["spacing"] ?? top["space"];

  const values = new Map<string, string>();

  const colors = entries(colorSection, most.colors).flatMap(
    ({ name, value, fields, at }) => {
      const usage = stringOf(fields?.["usage"]);
      const said = themed(value);

      if (name === "" || said === undefined) {
        problems.push(
          `color ${name === "" ? String(at + 1) : name} has no value`,
        );

        return [];
      }

      values.set(name, said);

      return [{ name, value: said, usage }];
    },
  );

  const resolved = colors.flatMap((each) => {
    const value = each.value.replace(
      /^\{([\w.-]+)\}$/,
      (whole, name: string) => values.get(name) ?? whole,
    );

    if (!shown.test(value) || /url\s*\(/i.test(value)) {
      problems.push(`color ${each.name} isn't a color: ${value.slice(0, 40)}`);

      return [];
    }

    return [{ ...each, value }];
  });

  const families = record(record(typeSection)?.["families"]) ?? {};

  const fontOf = (said: unknown): string => {
    const named = stringOf(said);
    const font = stringOf(families[named]) || named;

    return family.test(font) ? font : "";
  };

  const groups = record(typeSection)?.["groups"];

  const styles = Array.isArray(groups)
    ? groups.flatMap((group) =>
        entries(record(group)?.["styles"], most.type).map((each) => ({
          ...each,
          family: record(group)?.["family"],
        })),
      )
    : entries(record(typeSection)?.["styles"] ?? typeSection, most.type).map(
        (each) => ({ ...each, family: undefined }),
      );

  const type = styles
    .slice(0, most.type)
    .flatMap(({ name, value, fields, at, ...group }) => {
      const style = fields;
      const size = cssLength(style?.["fontSize"] ?? style?.["size"] ?? value);

      if (name === "" || size === "") {
        problems.push(
          `type style ${name === "" ? String(at + 1) : name} has no font size`,
        );

        return [];
      }

      return [
        {
          name,
          family: fontOf(
            style?.["family"] ?? style?.["fontFamily"] ?? group.family,
          ),
          size,
          lineHeight:
            typeof style?.["lineHeight"] === "number"
              ? String(style["lineHeight"])
              : cssLength(style?.["lineHeight"]),
          weight: String(
            numberOf(style?.["fontWeight"] ?? style?.["weight"]) ?? "",
          ),
          letterSpacing: cssLength(style?.["letterSpacing"]),
          sample: stringOf(style?.["sample"]),
          usage: stringOf(style?.["usage"]),
        },
      ];
    });

  const spacing = entries(spaceSection, most.spacing).flatMap(
    ({ name, value, fields, at }) => {
      const said = cssLength(value);

      if (name === "" || said === "") {
        problems.push(
          `spacing ${name === "" ? String(at + 1) : name} has no length`,
        );

        return [];
      }

      return [{ name, value: said, usage: stringOf(fields?.["usage"]) }];
    },
  );

  for (const [said, found] of [
    ["colors", resolved],
    ["type", type],
    ["spacing", spacing],
  ] as const) {
    if (found.length === 0) {
      problems.push(`tokens.json has no ${said}`);
    }
  }

  return { tokens: { colors: resolved, type, spacing }, problems };
}

// The components a system's folder holds, by their folders' names.
export function componentsOf(
  paths: readonly string[],
): readonly SystemComponent[] {
  return paths
    .flatMap((path) => {
      const name = /^components\/([^/]+)\/preview\.html$/.exec(path)?.[1];

      return name === undefined ? [] : [{ name, file: path }];
    })
    .slice(0, most.components);
}

// A system's swatch: its ground and its ink, by their usual names.
export function thumbOf(
  colors: readonly SystemColor[],
): SystemSummary["thumb"] {
  const named = (...names: readonly string[]): string | undefined =>
    names
      .map((name) => colors.find((each) => each.name === name)?.value)
      .find((value) => value !== undefined);

  return {
    ground:
      named("paper", "bg", "background", "ground", "surface") ??
      colors[0]?.value ??
      "#ffffff",
    ink:
      named("ink", "text", "fg", "foreground") ?? colors[1]?.value ?? "#000000",
  };
}

// Which system and version an artifact's copy is, from its system.json.
export function recordOf(
  text: string,
): Pick<UsedSystem, "id" | "name" | "version"> | undefined {
  try {
    const read = record(JSON.parse(text));
    const id = stringOf(read?.["id"]);
    const version = numberOf(read?.["version"]);

    return id === "" || version === undefined
      ? undefined
      : { id, name: stringOf(read?.["name"]) || id, version };
  } catch {
    return undefined;
  }
}

// What changed between two versions of a system's tokens and files: the
// tokens whose values differ and the components whose pages do.
export function changesOf(
  was: SystemTokens,
  now: SystemTokens,
  components: readonly string[],
): readonly string[] {
  const keyed = (tokens: SystemTokens): Map<string, string> =>
    new Map([
      ...tokens.colors.map((each) => [each.name, each.value] as const),
      ...tokens.type.map((each) => [each.name, JSON.stringify(each)] as const),
      ...tokens.spacing.map((each) => [each.name, each.value] as const),
    ]);

  const before = keyed(was);
  const after = keyed(now);

  return [
    ...[...after].flatMap(([name, value]) =>
      before.get(name) === value ? [] : [name],
    ),
    ...[...before.keys()].filter((name) => !after.has(name)),
    ...components,
  ];
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 500) : "";
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return typeof value === "string" && /^\d+$/.test(value)
    ? Number(value)
    : undefined;
}

// A list of {name, …} or a map of name to value, in order, with the fields
// of each and its value.
function entries(
  section: unknown,
  cap: number,
): readonly {
  readonly name: string;
  readonly value: unknown;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
  readonly at: number;
}[] {
  const listed = record(section)?.["tokens"] ?? section;

  if (Array.isArray(listed)) {
    return listed.slice(0, cap).map((each: unknown, at) => ({
      name: stringOf(record(each)?.["name"]),
      value: record(each)?.["value"],
      fields: record(each),
      at,
    }));
  }

  return Object.entries(record(listed) ?? {})
    .filter(([name]) => !sectionKeys.has(name))
    .slice(0, cap)
    .map(([name, value], at) => ({
      name: name.trim(),
      value: record(value)?.["value"] ?? value,
      fields: record(value),
      at,
    }));
}

// One value, or of a value per theme the light one, else the first.
function themed(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() === "" ? undefined : value.trim();
  }

  const themes = record(value);

  if (themes === undefined) {
    return undefined;
  }

  const said = themes["light"] ?? Object.values(themes)[0];

  return typeof said === "string" && said.trim() !== ""
    ? said.trim()
    : undefined;
}

function cssLength(value: unknown): string {
  const said =
    typeof value === "number" ? `${String(value)}px` : stringOf(value);

  return /^-?\d*\.?\d+(px|rem|em|%|pt)?$/.test(said) ? said : "";
}
