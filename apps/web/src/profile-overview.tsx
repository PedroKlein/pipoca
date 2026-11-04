import { json, useLoaded } from "@pipoca/plugins/web";
import type { PiPackage, Profile } from "@pipoca/protocol";
import {
  Button,
  cn,
  fieldClass,
  Icon,
  initialsOf,
  Row,
  Rows,
  Section,
  Segmented,
} from "@pipoca/ui";
import { type ReactElement, type ReactNode, useState } from "react";
import { send } from "./api";
import { messageOf } from "./profile-files";

interface Skill {
  readonly name: string;
  readonly description: string;
}

type SystemPrompt = "own" | "add" | "replace";

const previewLines = 3;

const systemPromptNotes: Readonly<Record<SystemPrompt, string>> = {
  own: "Sessions use Pi's own system prompt.",
  add: "Added to the end of Pi's own prompt.",
  replace:
    "Replacing it drops Pi's built-in guidance for tools; most Profiles only add to it.",
};

// A Profile at a glance, as the mockups lay it out (ADR 0063). Each card
// opens its tab to edit the files behind it.
export function ProfileOverview({
  profile,
  editable,
  onChange,
  children,
}: {
  readonly profile: Profile;
  readonly editable: boolean;
  readonly onChange: () => void;
  readonly children?: ReactNode;
}): ReactElement {
  const url = `/api/profiles/${profile.id}/files`;
  const tab = (name: string): string => `#profiles/${profile.id}/${name}`;

  const { value: files } = useLoaded(
    async () => {
      const entries = await json<{ readonly path: string }[]>(fetch(url));
      const paths = entries.map(({ path }) => path);

      const skills = await Promise.all(
        paths
          .filter((path) => /^skills\/(.+\/)?[^/]+\/SKILL\.md$/.test(path))
          .map(async (path) => skillOf(path, await textOf(url, path))),
      );

      const prompts = paths.flatMap((path) => {
        const name = /^prompts\/([^/]+)\.md$/.exec(path)?.[1];

        return name === undefined ? [] : [name];
      });

      return { skills, prompts };
    },
    url,
    { topics: ["profiles"] },
  );

  const [error, setError] = useState<string>();

  const save = (body: Partial<Profile>): void => {
    send(`/api/profiles/${profile.id}`, "PUT", body).then(
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
      {error !== undefined && (
        <p role="alert" className="mt-4 text-caption text-failed">
          {error}
        </p>
      )}
      <Instructions text={profile.agentsMd} edit={tab("instructions")} />
      <SystemPromptCard
        key={`${profile.systemMd}:${profile.appendSystemMd}`}
        profile={profile}
        editable={editable}
        onSave={save}
      />
      <Section
        title="Skills"
        description={
          files ? plural(files.skills.length, "skill") : "Reading the folder"
        }
        actions={editable && <AddLink href={tab("skills")} label="Add skill" />}
      >
        {files && files.skills.length > 0 && (
          <ul
            aria-label="Skills"
            className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3"
          >
            {files.skills.map(({ name, description }) => (
              <li
                key={name}
                className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-line bg-elevated px-4 py-3 shadow-xs"
              >
                <span className="truncate text-ui font-medium text-fg-strong">
                  {name}
                </span>
                <span className="truncate text-label text-fg-dim">
                  {description}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
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
          className="rounded-md px-2 py-1 text-label text-fg-dim hover:bg-hover hover:text-fg"
        >
          Edit
        </a>
      }
    >
      <div className="rounded-lg border border-line bg-elevated px-5 py-4 text-ui text-fg shadow-xs">
        {lines.length === 0 ? (
          <span className="text-fg-dim">
            No instructions yet. Sessions get only the repository&apos;s
            AGENTS.md.
          </span>
        ) : (
          <>
            {shown.map((line, index) => (
              <p key={index} className="min-h-5 break-words">
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
      </div>
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

            return (
              <Row
                key={`${source}:${String(index)}`}
                initials={source.slice(0, 2)}
                title={nameOf(source)}
                description={<span className="font-mono">{source}</span>}
              >
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
              </Row>
            );
          })}
        </Rows>
      )}
    </Section>
  );
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

async function textOf(url: string, path: string): Promise<string> {
  const response = await fetch(`${url}/${encodeURIComponent(path)}`);

  return response.ok ? response.text() : "";
}

function skillOf(path: string, text: string): Skill {
  const field = (key: string): string | undefined =>
    new RegExp(`^${key}:\\s*(.+)$`, "m").exec(
      /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "",
    )?.[1];

  return {
    name: field("name") ?? path.split("/").at(-2) ?? path,
    description: field("description") ?? "",
  };
}

function serverOf(config: unknown): string {
  const { url, command, args } = (config ?? {}) as Record<string, unknown>;

  if (typeof url === "string") {
    return url;
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

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}
