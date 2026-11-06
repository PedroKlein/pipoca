import type { Profile } from "@pipoca/protocol";
import {
  Button,
  ChoiceCard,
  ErrorText,
  FileButton,
  Icon,
  TextInput,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { request } from "../data/client";
import { useAction } from "../data/hooks";
import { groups, type Picked, pickedOf, filesToImport } from "./profile-import";

type Choice = "folder" | "git" | "clean";

// Brings an existing Pi setup into the person's default Profile, item by
// item, or starts one from a repository (ADR 0063).
export function ProfileStep({
  profiles,
}: {
  readonly profiles: readonly Profile[];
}): ReactElement {
  const [choice, setChoice] = useState<Choice>("folder");
  const [picked, setPicked] = useState<Picked>();
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());
  const [url, setUrl] = useState("");
  const [done, setDone] = useState<string>();

  const target = profiles.find(({ isDefault }) => isDefault);

  const toggle = (id: string): void => {
    const next = new Set(left);

    if (!next.delete(id)) {
      next.add(id);
    }

    setLeft(next);
  };

  const action = useAction(async (work: () => Promise<string>) => {
    setDone(undefined);
    setDone(await work());
  });

  const run = (work: () => Promise<string>): void => {
    void action.run(work);
  };

  const kept = picked?.items.filter(({ id }) => !left.has(id)).length ?? 0;

  const option = (
    value: Choice,
    title: string,
    description: string,
    body?: ReactElement,
  ): ReactElement => (
    <ChoiceCard
      as="li"
      name="profile-start"
      checked={choice === value}
      onChange={() => {
        setChoice(value);
      }}
      title={title}
      description={description}
    >
      {body}
    </ChoiceCard>
  );

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-2.5">
        {option(
          "folder",
          "Bring my Pi setup",
          "Pick your ~/.pi/agent folder. Click anything to leave it out. Logins and history stay behind.",
          <div className="flex flex-col gap-3">
            <FileButton
              className="self-start"
              {...{ webkitdirectory: "" }}
              onFiles={(files) => {
                void pickedOf(files).then((next) => {
                  setPicked(next);
                  setLeft(new Set());
                });
              }}
            >
              {picked === undefined ? "Pick the folder" : "Pick another folder"}
            </FileButton>
            {picked !== undefined && (
              <ul
                aria-label="What the folder holds"
                className="flex flex-col rounded-lg border border-line bg-bg"
              >
                {picked.items.length === 0 && (
                  <li className="px-4 py-3 text-label text-fg-dim">
                    This folder holds no instructions, skills, packages or MCP
                    servers.
                  </li>
                )}
                {groups.map((group) => {
                  const items = picked.items.filter(
                    (item) => item.group === group,
                  );

                  if (items.length === 0) {
                    return null;
                  }

                  return (
                    <li
                      key={group}
                      className="flex flex-col gap-2 border-t border-line px-4 py-3 first:border-t-0"
                    >
                      <span className="text-ui font-medium text-fg-strong">
                        {group}
                        {items.length > 1 &&
                          ` · ${String(items.filter(({ id }) => !left.has(id)).length)} of ${String(items.length)}`}
                      </span>
                      <span className="flex flex-wrap gap-1.5">
                        {items.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            aria-pressed={!left.has(item.id)}
                            onClick={() => {
                              toggle(item.id);
                            }}
                            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-elevated px-2.5 text-label text-fg-dim line-through aria-pressed:text-fg aria-pressed:no-underline"
                          >
                            {!left.has(item.id) && (
                              <Icon name="check" className="size-3.5" />
                            )}
                            {item.label}
                          </button>
                        ))}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {picked !== undefined && target !== undefined && (
              <Button
                variant="primary"
                className="self-start"
                onClick={() => {
                  run(async () => {
                    await request("profiles.files.upload", {
                      params: { id: target.id },
                      body: { files: await filesToImport(picked, left) },
                    });

                    return `Imported ${String(kept)} items into ${target.name}.`;
                  });
                }}
              >
                Import {kept} {kept === 1 ? "item" : "items"}
              </Button>
            )}
          </div>,
        )}
        {option(
          "git",
          "Start from a git repository",
          "A repository with a Pi agent folder, such as your dotfiles. It becomes your default Profile.",
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();

              run(async () => {
                const made = await request("profiles.create", {
                  body: { source: { url } },
                });

                await request("profiles.update", {
                  params: { id: made.id },
                  body: { isDefault: true },
                });

                return `Made ${made.name} your default Profile.`;
              });
            }}
          >
            <TextInput
              aria-label="Repository address"
              required
              value={url}
              placeholder="https://github.com/you/dotfiles.git"
              onChange={(event) => {
                setUrl(event.target.value);
              }}
              className="min-w-60 flex-1"
            />
            <Button variant="primary" type="submit">
              Import
            </Button>
          </form>,
        )}
        {option(
          "clean",
          "Start clean",
          "Pi's defaults. Add skills and tools later in Settings, Profiles.",
        )}
      </ul>
      {done !== undefined && (
        <p role="status" className="text-label text-done">
          {done}
        </p>
      )}
      <ErrorText>{action.error}</ErrorText>
    </div>
  );
}
