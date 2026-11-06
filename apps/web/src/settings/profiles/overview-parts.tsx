import type { Profile } from "@pipoca/protocol";
import {
  Button,
  Card,
  cardClass,
  cn,
  Icon,
  plural,
  Section,
  Segmented,
  Switch,
  TextArea,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";

export interface Skill {
  readonly folder: string;
  readonly name: string;
  readonly description: string;
  // The layer below this Profile that it comes from, if not its own.
  readonly from?: string;
}

export interface Below {
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

function systemPromptOf(profile: Profile): SystemPrompt {
  if (profile.systemMd.trim() !== "") {
    return "replace";
  }

  return profile.appendSystemMd.trim() === "" ? "own" : "add";
}
