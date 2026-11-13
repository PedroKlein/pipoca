import {
  Button,
  ChoiceCard,
  ErrorText,
  FileButton,
  Icon,
  TextInput,
} from "@pipoca/ui";
import type { ListedProfile, RepositoryManifest } from "@pipoca/protocol";
import { type ReactElement, useState } from "react";
import { request } from "../data/client";
import { seed, useAction } from "../data/hooks";
import { NothingListed } from "../settings/profiles/nothing-listed";
import { StepFooter } from "./footer";
import { groups, type Picked, pickedOf, filesToImport } from "./profile-import";

type Choice = "team" | "folder" | "git" | "clean";

interface Found {
  readonly url: string;
  readonly manifest: RepositoryManifest;
}

// Starts the person's own setup from a team Profile, an existing Pi setup
// item by item into My defaults, or a repository (ADR 0063). Pi's defaults is an
// answer too, so the step always has one and no Skip (ADR 0072).
export function ProfileStep({
  team,
}: {
  // The team Profiles on offer, drawn as chips to pick.
  readonly team?: ReactElement | undefined;
}): ReactElement {
  const [choice, setChoice] = useState<Choice>("clean");
  const [picked, setPicked] = useState<Picked>();
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());
  const [url, setUrl] = useState("");
  const [found, setFound] = useState<Found>();
  const [path, setPath] = useState<string>();
  const [done, setDone] = useState<string>();

  const toggle = (id: string): void => {
    const next = new Set(left);

    if (!next.delete(id)) {
      next.add(id);
    }

    setLeft(next);
  };

  const action = useAction(async (work: () => Promise<string>) => {
    setDone(undefined);
    const said = await work();
    setDone(said === "" ? undefined : said);
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
    <div className="flex flex-col gap-7">
      <ul
        role="radiogroup"
        aria-label="Starting Profile"
        className="flex flex-col gap-2.5"
      >
        {team !== undefined &&
          option(
            "team",
            "Copy a team Profile",
            "Start from one your team offers. Yours is yours to change; the team Profile stays as it is for team Sessions.",
            team,
          )}
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
            {picked !== undefined && (
              <>
                <p className="text-label text-fg-dim">
                  Goes into{" "}
                  <span className="font-medium text-fg">My defaults</span>,
                  yours alone, under every Profile of yours. Packages and MCP
                  servers are added to what's there, never replace it. The
                  server's shared Default stays as it is.
                </p>
                <Button
                  variant="primary"
                  className="self-start"
                  onClick={() => {
                    run(async () => {
                      const existing = await request("me.profileDefaults");

                      await request("me.profileDefaults.files.upload", {
                        body: {
                          files: await filesToImport(picked, left, existing),
                        },
                      });

                      return `Imported ${String(kept)} ${kept === 1 ? "item" : "items"} into My defaults.`;
                    });
                  }}
                >
                  Import {kept} {kept === 1 ? "item" : "items"} into My defaults
                </Button>
              </>
            )}
          </div>,
        )}
        {option(
          "git",
          "Start from a git repository",
          "A repository with a pipoca.json at its root that says where its Pi config is.",
          <div className="flex flex-col gap-3">
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const looked = url.trim();

                run(async () => {
                  setFound(undefined);

                  const manifest = await request("repositories.manifest", {
                    query: { url: looked },
                  });

                  setFound({ url: looked, manifest });
                  setPath(manifest.profiles[0]?.path);

                  return "";
                });
              }}
            >
              <TextInput
                aria-label="Repository address"
                required
                value={url}
                placeholder="https://git.example.com/you/dotfiles.git"
                onChange={(event) => {
                  setUrl(event.target.value);
                }}
                className="min-w-60 flex-1"
              />
              <Button type="submit">Look</Button>
            </form>
            {found !== undefined && found.manifest.profiles.length > 0 && (
              <Listed
                found={found}
                path={path}
                onPath={setPath}
                onPick={(entry) => {
                  run(async () => {
                    const made = await request("profiles.create", {
                      body: { source: { url: found.url, path: entry.path } },
                    });

                    await request("profiles.update", {
                      params: { id: made.id },
                      body: { isDefault: true },
                    });

                    return `Made ${made.name} your default Profile.`;
                  });
                }}
              />
            )}
            {found?.manifest.profiles.length === 0 && (
              <NothingListed found={found.manifest.found} />
            )}
          </div>,
        )}
        {option(
          "clean",
          "Pi's defaults",
          "Nothing to bring. Add skills and tools later in Settings, Profiles.",
        )}
      </ul>
      {done !== undefined && (
        <p role="status" className="text-label text-done">
          {done}
        </p>
      )}
      <ErrorText>{action.error}</ErrorText>
      <StepFooter
        answer={
          choice === "clean"
            ? async () => {
                seed(
                  "me.setup",
                  await request("me.setup.update", {
                    body: { dismiss: "profile" },
                  }),
                );
              }
            : undefined
        }
      />
      <p className="-mt-4 text-caption text-fg-dim">
        This is only your default. Make more Profiles any time in Settings,
        Profiles: from scratch, a copy of a team Profile, a folder or a
        repository.
      </p>
    </div>
  );
}

function holdings({ path, holds }: ListedProfile): string {
  if (holds === undefined) {
    return `${path} · not in the repository`;
  }

  const parts = [
    holds.skills > 0 &&
      `${String(holds.skills)} ${holds.skills === 1 ? "skill" : "skills"}`,
    holds.packages > 0 &&
      `${String(holds.packages)} ${holds.packages === 1 ? "package" : "packages"}`,
    holds.agentsMd && "AGENTS.md",
  ].filter((part) => part !== false);

  return [path, parts.length === 0 ? "empty" : parts.join(", ")].join(" · ");
}

// The Profiles a repository's pipoca.json lists, one to make the default.
function Listed({
  found: { url, manifest },
  path,
  onPath,
  onPick,
}: {
  readonly found: Found;
  readonly path: string | undefined;
  readonly onPath: (path: string) => void;
  readonly onPick: (entry: ListedProfile) => void;
}): ReactElement {
  const count = manifest.profiles.length;
  const picked = manifest.profiles.find((entry) => entry.path === path);

  const repository =
    url
      .replace(/\.git$/, "")
      .split("/")
      .at(-1) ?? url;

  return (
    <div
      role="group"
      aria-label="Profiles in the repository"
      className="flex flex-col gap-3 rounded-lg border border-line bg-bg p-4"
    >
      <span className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-ui font-medium text-fg-strong">
          pipoca.json lists {count} {count === 1 ? "Profile" : "Profiles"}
        </span>
        <span className="font-mono text-mono-sm text-fg-dim">
          {repository} @ {manifest.commit.slice(0, 7)}
        </span>
      </span>
      <ul className="flex flex-col gap-1.5">
        {manifest.profiles.map((entry) => (
          <li key={entry.path}>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-hover">
              <input
                type="radio"
                name="listed-profile"
                className="mt-1"
                checked={entry.path === path}
                onChange={() => {
                  onPath(entry.path);
                }}
              />
              <span className="flex flex-col">
                <span className="text-label font-medium text-fg">
                  {entry.name}
                </span>
                <span className="font-mono text-mono-sm text-fg-dim">
                  {holdings(entry)}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <span className="text-caption text-fg-dim">
        It stays in sync: pushes to the repository update the Profile.
      </span>
      {picked !== undefined && (
        <Button
          variant="primary"
          className="self-start"
          onClick={() => {
            onPick(picked);
          }}
        >
          Make “{picked.name}” my default Profile
        </Button>
      )}
    </div>
  );
}
