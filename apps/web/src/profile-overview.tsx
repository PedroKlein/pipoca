import { json, useLoaded } from "@pipoca/plugins/web";
import { apiPath, type PiPackage, type Profile } from "@pipoca/protocol";
import {
  Badge,
  Button,
  Card,
  cardClass,
  cn,
  ErrorText,
  fieldClass,
  Icon,
  initialsOf,
  plural,
  Row,
  Rows,
  Section,
  Segmented,
  Switch,
} from "@pipoca/ui";
import { type ReactElement, type ReactNode, useEffect, useState } from "react";
import { api } from "./api";
import { messageOf } from "./profile-files";

interface Skill {
  readonly folder: string;
  readonly name: string;
  readonly description: string;
  // The layer below this Profile that it comes from, if not its own.
  readonly from?: string;
}

interface Below {
  readonly name: string;
  readonly url: string;
}

type SystemPrompt = "own" | "add" | "replace";

const previewLines = 3;

const systemPromptNotes: Readonly<Record<SystemPrompt, string>> = {
  own: "Sessions use Pi's own system prompt.",
  add: "Added to the end of Pi's own prompt.",
  replace:
    "Replacing it drops Pi's built-in guidance for tools; most Profiles only add to it.",
};

// Where Profiles open: the team's in Team setup, which never load anyone's
// My defaults (ADR 0064).
export function profilesPath(team: boolean): string {
  return team ? "team/setup/profiles" : "profiles";
}

// A Profile at a glance, as the mockups lay it out (ADR 0063). Each card
// opens its tab to edit the files behind it.
export function ProfileOverview({
  profile,
  profiles,
  editable,
  onChange,
  children,
}: {
  readonly profile: Profile;
  readonly profiles: readonly Profile[];
  readonly editable: boolean;
  readonly onChange: () => void;
  readonly children?: ReactNode;
}): ReactElement {
  const url = apiPath("profiles.files", { params: { id: profile.id } });

  const tab = (name: string): string =>
    `#${profilesPath(profile.ownerId === "team")}/${profile.id}/${name}`;

  const below: readonly Below[] = [
    ...chainOf(profile, profiles).map(({ id, name }) => ({
      name,
      url: apiPath("profiles.files", { params: { id } }),
    })),
    ...(profile.ownerId === "team"
      ? []
      : [{ name: "My defaults", url: apiPath("me.profileDefaults.files") }]),
    { name: "Server base", url: apiPath("settings.baseProfile.files") },
  ];

  const { value: files } = useLoaded(
    async () => {
      const [own, ...layers] = await Promise.all(
        [{ name: "", url }, ...below].map(async (layer) =>
          skillsIn(layer.url, layer.name === "" ? undefined : layer.name),
        ),
      );

      const skills = [own ?? [], ...layers].reduce<readonly Skill[]>(
        (found, layer) => [
          ...found,
          ...layer.filter(
            ({ folder }) => !found.some((skill) => skill.folder === folder),
          ),
        ],
        [],
      );

      const entries = await json<{ readonly path: string }[]>(fetch(url));

      const prompts = entries.flatMap(({ path }) => {
        const name = /^prompts\/([^/]+)\.md$/.exec(path)?.[1];

        return name === undefined ? [] : [name];
      });

      return { skills, prompts };
    },
    `${url}:${below.map(({ url: each }) => each).join(",")}`,
    { topics: ["profiles"] },
  );

  const [error, setError] = useState<string>();

  const save = (body: Partial<Profile>): void => {
    api("profiles.update", { params: { id: profile.id }, body }).then(
      () => {
        setError(undefined);
        onChange();
      },
      (reason: unknown) => {
        setError(messageOf(reason));
      },
    );
  };

  return (
    <>
      <ErrorText size="caption" className="mt-4">
        {error}
      </ErrorText>
      <Instructions text={profile.agentsMd} edit={tab("instructions")} />
      <SystemPromptCard
        key={`${profile.systemMd}:${profile.appendSystemMd}`}
        profile={profile}
        editable={editable}
        onSave={save}
      />
      <Skills
        skills={files?.skills}
        off={offSkills(profile.settings)}
        editable={editable}
        add={tab("skills")}
        onToggle={(folder, on) => {
          save({ settings: withSkill(profile.settings, folder, on) });
        }}
      />
      <Packages
        packages={profile.packages}
        editable={editable}
        onSave={(packages) => {
          save({ packages });
        }}
      />
      <Section
        title="MCP servers"
        actions={editable && <AddLink href={tab("mcp")} label="Add server" />}
      >
        {Object.keys(profile.mcpServers).length > 0 && (
          <Rows label="MCP servers">
            {Object.entries(profile.mcpServers).map(([name, config]) => (
              <Row
                key={name}
                initials={initialsOf(name)}
                title={name}
                description={
                  <span className="font-mono">{serverOf(config)}</span>
                }
              />
            ))}
          </Rows>
        )}
      </Section>
      {children}
      <Section title="Prompts" description="Slash commands in the composer">
        <ul aria-label="Prompts" className="flex flex-wrap gap-1.5">
          {files?.prompts.map((name) => (
            <li
              key={name}
              className="rounded-full border border-line bg-elevated px-3 py-1 font-mono text-mono-sm"
            >
              /{name}
            </li>
          ))}
          {editable && (
            <li>
              <a
                href={tab("prompts")}
                className="inline-flex rounded-full border border-dashed border-line-strong px-3 py-1 text-label text-fg-dim hover:text-fg"
              >
                Add prompt
              </a>
            </li>
          )}
        </ul>
      </Section>
    </>
  );
}

function Instructions({
  text,
  edit,
}: {
  readonly text: string;
  readonly edit: string;
}): ReactElement {
  const lines = text.trim() === "" ? [] : text.trim().split("\n");
  const shown = lines.slice(0, previewLines);

  return (
    <Section
      title="Instructions"
      description="AGENTS.md"
      actions={
        <a
          href={edit}
          aria-label="Edit instructions"
          className="rounded-md px-2 py-1 text-label text-fg-dim hover:bg-hover hover:text-fg"
        >
          Edit
        </a>
      }
    >
      <Card padding="none" className="px-5 py-4 text-ui text-fg">
        {lines.length === 0 ? (
          <span className="text-fg-dim">
            No instructions yet. Sessions get only the repository&apos;s
            AGENTS.md.
          </span>
        ) : (
          <>
            {shown.map((line, index) => (
              <p
                key={index}
                className={cn(
                  "min-h-5 break-words",
                  /^#+\s/.test(line) && "mb-1 font-medium text-fg-strong",
                )}
              >
                {line.replace(/^#+\s*/, "")}
              </p>
            ))}
            {lines.length > shown.length && (
              <p className="mt-1.5 text-label text-fg-dim">
                and {plural(lines.length - shown.length, "more line")}
              </p>
            )}
          </>
        )}
      </Card>
    </Section>
  );
}

function SystemPromptCard({
  profile,
  editable,
  onSave,
}: {
  readonly profile: Profile;
  readonly editable: boolean;
  readonly onSave: (body: Partial<Profile>) => void;
}): ReactElement {
  const initial = systemPromptOf(profile);

  const [mode, setMode] = useState(initial);

  const [text, setText] = useState(
    initial === "replace" ? profile.systemMd : profile.appendSystemMd,
  );

  const changed =
    mode !== initial ||
    text !==
      (initial === "replace" ? profile.systemMd : profile.appendSystemMd);

  return (
    <Section
      title="System prompt"
      description="SYSTEM.md or APPEND_SYSTEM.md"
      actions={
        editable && (
          <Segmented
            label="System prompt"
            options={[
              { value: "own", label: "Pi's own" },
              { value: "add", label: "Add to Pi's" },
              { value: "replace", label: "Replace it" },
            ]}
            value={mode}
            onChange={setMode}
          />
        )
      }
    >
      {mode !== "own" && (
        <textarea
          aria-label={mode === "add" ? "Added to Pi's prompt" : "System prompt"}
          rows={3}
          value={text}
          readOnly={!editable}
          onChange={(event) => {
            setText(event.target.value);
          }}
          placeholder={
            mode === "add" ? "Always reply in English." : "You are a careful…"
          }
          className={cn(fieldClass, "min-h-20 resize-y")}
        />
      )}
      <p className="text-caption text-fg-dim">{systemPromptNotes[mode]}</p>
      {editable && changed && (
        <span>
          <Button
            variant="primary"
            onClick={() => {
              onSave({
                systemMd: mode === "replace" ? text : "",
                appendSystemMd: mode === "add" ? text : "",
              });
            }}
          >
            Save system prompt
          </Button>
        </span>
      )}
    </Section>
  );
}

function Skills({
  skills,
  off,
  editable,
  add,
  onToggle,
}: {
  readonly skills: readonly Skill[] | undefined;
  readonly off: ReadonlySet<string>;
  readonly editable: boolean;
  readonly add: string;
  readonly onToggle: (folder: string, on: boolean) => void;
}): ReactElement {
  const inherited = (skills ?? []).filter(({ from }) => from !== undefined);
  const layers = [...new Set(inherited.map(({ from }) => from))];

  const on = (skills ?? []).filter(
    ({ folder, from }) => from === undefined && !off.has(folder),
  ).length;

  const description =
    skills === undefined
      ? "Reading the folder"
      : [
          `${String(on)} on`,
          ...(inherited.length === 0
            ? []
            : [
                `${String(inherited.length)} from ${layers.length === 1 ? (layers[0] ?? "") : "below"}`,
              ]),
        ].join(", ");

  return (
    <Section
      title="Skills"
      description={description}
      actions={editable && <AddLink href={add} label="Add skill" />}
    >
      {skills && skills.length > 0 && (
        <ul
          aria-label="Skills"
          className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3"
        >
          {skills.map(({ folder, name, description: about, from }) => (
            <li
              key={folder}
              className={cn(
                cardClass,
                "flex min-w-0 items-center gap-3 px-4 py-3",
                from !== undefined && "bg-panel",
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-ui font-medium text-fg-strong">
                  {name}
                </span>
                <span className="truncate text-label text-fg-dim">
                  {from === undefined ? about : `From ${from}`}
                </span>
              </span>
              {from === undefined ? (
                <Switch
                  label={name}
                  labelHidden
                  checked={!off.has(folder)}
                  disabled={!editable}
                  onChange={(checked) => {
                    onToggle(folder, checked);
                  }}
                />
              ) : (
                <Icon name="lock" className="size-4 shrink-0 text-fg-dim" />
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Packages({
  packages,
  editable,
  onSave,
}: {
  readonly packages: readonly PiPackage[];
  readonly editable: boolean;
  readonly onSave: (packages: readonly PiPackage[]) => void;
}): ReactElement {
  const [adding, setAdding] = useState(false);
  const latest = useLatest(packages);

  const replace = (index: number, pkg: PiPackage): void => {
    onSave(packages.map((each, n) => (n === index ? pkg : each)));
  };

  return (
    <Section
      title="Packages"
      description="Pi extensions, from npm, git or a folder"
      actions={
        editable && (
          <Button
            onClick={() => {
              setAdding(!adding);
            }}
          >
            <Icon name="plus" />
            Add package
          </Button>
        )
      }
    >
      {adding && (
        <form
          aria-label="Add package"
          onSubmit={(event) => {
            event.preventDefault();
            const source = new FormData(event.currentTarget).get("source");

            if (typeof source === "string" && source.trim() !== "") {
              onSave([...packages, source.trim()]);
              setAdding(false);
            }
          }}
          className="flex gap-2"
        >
          <input
            name="source"
            required
            aria-label="Package source"
            placeholder="npm:pi-subagents, git:… or a path"
            className={cn(fieldClass, "flex-1 font-mono")}
          />
          <Button type="submit">Add</Button>
        </form>
      )}
      {packages.length > 0 && (
        <Rows label="Packages">
          {packages.map((pkg, index) => {
            const source = typeof pkg === "string" ? pkg : pkg.source;
            const pinned = pinnedOf(source);
            const newer = pinned && latest.get(pinned.name);

            const update =
              newer !== undefined &&
              pinned !== undefined &&
              isNewer(newer, pinned.version);

            return (
              <Row
                key={`${source}:${String(index)}`}
                initials={source.slice(0, 2)}
                title={
                  <>
                    {nameOf(source)}
                    {update && <Badge state="working">{newer} available</Badge>}
                  </>
                }
                description={<span className="font-mono">{source}</span>}
              >
                {editable && update && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      replace(
                        index,
                        withSource(pkg, `npm:${pinned.name}@${newer}`),
                      );
                    }}
                  >
                    Update
                  </Button>
                )}
                {editable && (
                  <Button
                    variant="ghost"
                    aria-label={`Remove ${source}`}
                    onClick={() => {
                      onSave(packages.filter((_each, n) => n !== index));
                    }}
                  >
                    Remove
                  </Button>
                )}
                <Switch
                  label={source}
                  labelHidden
                  checked={!isOff(pkg)}
                  disabled={!editable}
                  onChange={(on) => {
                    replace(index, on ? source : offPackage(source));
                  }}
                />
              </Row>
            );
          })}
        </Rows>
      )}
    </Section>
  );
}

const resourceKinds = ["extensions", "skills", "prompts", "themes"] as const;

// Pi installs a package whose filters are all empty but loads none of it.
function offPackage(source: string): PiPackage {
  return {
    source,
    ...Object.fromEntries(resourceKinds.map((kind) => [kind, []])),
  };
}

function isOff(pkg: PiPackage): boolean {
  return (
    typeof pkg !== "string" &&
    resourceKinds.every((kind) => pkg[kind]?.length === 0)
  );
}

function isNewer(version: string, than: string): boolean {
  const parts = (text: string): readonly number[] =>
    text.split(".").map(Number);

  const [a, b] = [parts(version), parts(than)];
  const index = a.findIndex((part, n) => part !== b[n]);

  return index !== -1 && (a[index] ?? 0) > (b[index] ?? 0);
}

function withSource(pkg: PiPackage, source: string): PiPackage {
  return typeof pkg === "string" ? source : { ...pkg, source };
}

function pinnedOf(
  source: string,
): { readonly name: string; readonly version: string } | undefined {
  const match = /^npm:(@[^/@]+\/[^@]+|[^@]+)@(\d+\.\d+\.\d+)$/.exec(source);

  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { name: match[1], version: match[2] };
}

// The latest version on npm of each package pinned to one.
function useLatest(
  packages: readonly PiPackage[],
): ReadonlyMap<string, string> {
  const names = [
    ...new Set(
      packages.flatMap((pkg) => {
        const pinned = pinnedOf(typeof pkg === "string" ? pkg : pkg.source);

        return pinned ? [pinned.name] : [];
      }),
    ),
  ].join(" ");

  const [latest, setLatest] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    if (names === "") {
      return;
    }

    void Promise.all(
      names.split(" ").map(async (name) => {
        const response = await fetch(
          `https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`,
        );

        const { version } = (await response.json()) as { version?: unknown };

        return typeof version === "string" ? [[name, version] as const] : [];
      }),
    )
      .then((found) => {
        setLatest(new Map(found.flat()));
      })
      .catch(() => undefined);
  }, [names]);

  return latest;
}

function AddLink({
  href,
  label,
}: {
  readonly href: string;
  readonly label: string;
}): ReactElement {
  return (
    <a
      href={href}
      className="inline-flex h-control items-center gap-1.5 rounded-md border border-line bg-elevated px-3 text-ui font-medium text-fg shadow-xs hover:border-line-strong hover:bg-hover"
    >
      <Icon name="plus" />
      {label}
    </a>
  );
}

async function skillsIn(
  url: string,
  from: string | undefined,
): Promise<readonly Skill[]> {
  const entries = await json<{ readonly path: string }[]>(fetch(url)).catch(
    () => [],
  );

  return Promise.all(
    entries
      .filter(({ path }) => /^skills\/(.+\/)?[^/]+\/SKILL\.md$/.test(path))
      .map(async ({ path }) => {
        const response = await fetch(`${url}/${encodeURIComponent(path)}`);

        return skillOf(path, response.ok ? await response.text() : "", from);
      }),
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
function offSkills(settings: Profile["settings"]): ReadonlySet<string> {
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

function withSkill(
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
function chainOf(
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

function serverOf(config: unknown): string {
  const { url, command, args } = (config ?? {}) as Record<string, unknown>;

  if (typeof url === "string") {
    return URL.parse(url)?.host ?? url;
  }

  return [command, ...(Array.isArray(args) ? (args as unknown[]) : [])]
    .filter((part) => typeof part === "string")
    .join(" ");
}

function nameOf(source: string): string {
  const name = source
    .replace(/^(npm|git):/, "")
    .replace(/#.*$/, "")
    .replace(/\/+$/, "")
    .split("/")
    .at(-1)
    ?.replace(/(.)@[^@]*$/, "$1");

  return name === undefined || name === "" ? source : name;
}

function systemPromptOf(profile: Profile): SystemPrompt {
  if (profile.systemMd.trim() !== "") {
    return "replace";
  }

  return profile.appendSystemMd.trim() === "" ? "own" : "add";
}
