import type { ProfileContent } from "@pipoca/protocol";
import {
  Button,
  Card,
  cardClass,
  cn,
  Icon,
  Menu,
  plural,
  Section,
  Segmented,
  Switch,
  TextArea,
} from "@pipoca/ui";
import { type ReactElement, type ReactNode, useState } from "react";
import { SourceTag } from "./inherited";
import type { Inherited, StackLayer } from "./stack";

export interface Skill {
  readonly folder: string;
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

export function Instructions({
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

export function SystemPromptCard({
  content: profile,
  editable,
  onSave,
  children,
}: {
  readonly content: ProfileContent;
  readonly editable: boolean;
  readonly onSave: (body: Partial<ProfileContent>) => void;
  // What the layers below add to Pi's prompt.
  readonly children?: ReactNode;
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
        <TextArea
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
          className="min-h-20 resize-y"
        />
      )}
      {children}
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

export function Skills({
  skills,
  off,
  inherited,
  owner,
  editable,
  add,
  onToggle,
  onToggleInherited,
  onCopy,
}: {
  // The open layer's own, still reading while undefined.
  readonly skills: readonly Skill[] | undefined;
  readonly off: ReadonlySet<string>;
  readonly inherited: readonly Inherited<Skill>[];
  readonly owner: string;
  readonly editable: boolean;
  readonly add: string;
  readonly onToggle: (folder: string, on: boolean) => void;
  readonly onToggleInherited: (folder: string, on: boolean) => void;
  readonly onCopy: (from: StackLayer, folder: string) => void;
}): ReactElement {
  const own = skills ?? [];
  const replaced = new Set(own.map(({ folder }) => folder));
  const below = inherited.filter(({ key }) => !replaced.has(key));
  const on = own.filter(({ folder }) => !off.has(folder)).length;

  const description =
    skills === undefined
      ? "Reading the folder"
      : [
          `${String(on)} own`,
          ...(below.length === 0
            ? []
            : [
                `${String(below.filter((entry) => !entry.off).length)} inherited`,
              ]),
          ...(below.some((entry) => entry.off)
            ? [`${String(below.filter((entry) => entry.off).length)} off`]
            : []),
        ].join(", ");

  return (
    <Section
      title="Skills"
      description={description}
      actions={editable && <AddLink href={add} label="Add skill" />}
    >
      {own.length + below.length > 0 && (
        <ul
          aria-label="Skills"
          className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3"
        >
          {own.map(({ folder, name, description: about }) => {
            const replaces = inherited.find(({ key }) => key === folder);

            return (
              <li
                key={folder}
                className={cn(
                  cardClass,
                  "flex min-w-0 items-center gap-3 px-4 py-3",
                )}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate text-ui font-medium text-fg-strong">
                    {name}
                  </span>
                  <span className="truncate text-label text-fg-dim">
                    {replaces ? `Replaces ${replaces.from.name}'s` : about}
                  </span>
                </span>
                <Switch
                  label={name}
                  labelHidden
                  checked={!off.has(folder)}
                  disabled={!editable}
                  onChange={(checked) => {
                    onToggle(folder, checked);
                  }}
                />
              </li>
            );
          })}
          {below.map((entry) => (
            <li
              key={entry.key}
              className={cn(
                cardClass,
                "flex min-w-0 items-center gap-3 bg-panel px-4 py-3",
                entry.off && "opacity-60",
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
                <span className="max-w-full truncate text-ui font-medium text-fg-strong">
                  {entry.item.name}
                </span>
                <span className="max-w-full truncate text-label text-fg-dim">
                  {entry.off ? `Off in ${owner}` : entry.item.description}
                </span>
                <SourceTag name={entry.from.name} kind={entry.from.kind} />
              </span>
              {editable && (
                <Menu
                  label={`More for ${entry.item.name}`}
                  items={[
                    {
                      label: `Copy into ${owner} to change it`,
                      run: () => {
                        onCopy(entry.from, entry.key);
                      },
                    },
                  ]}
                />
              )}
              <Switch
                label={`${entry.item.name} in ${owner}`}
                labelHidden
                checked={!entry.off}
                disabled={!editable}
                onChange={(checked) => {
                  onToggleInherited(entry.key, checked);
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function AddLink({
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

function systemPromptOf(profile: ProfileContent): SystemPrompt {
  if (profile.systemMd.trim() !== "") {
    return "replace";
  }

  return profile.appendSystemMd.trim() === "" ? "own" : "add";
}
