import { profilePath, type Profile } from "@pipoca/protocol";
import { Button, ChoiceCard, cn, fieldClass, FileButton, Icon } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { api } from "./api";
import { base64 } from "./profile-files";

// One thing in a picked Pi agent folder that the person can leave out.
interface Item {
  readonly id: string;
  readonly group: Group;
  readonly label: string;
}

const groups = [
  "Instructions",
  "Skills",
  "Prompts",
  "Extensions",
  "Packages",
  "MCP servers",
] as const;

type Group = (typeof groups)[number];

interface Picked {
  // Paths inside the agent folder, with the picked folder's name left out.
  readonly files: ReadonlyMap<string, File>;
  readonly items: readonly Item[];
  readonly packages: readonly unknown[];
  readonly mcpServers: Readonly<Record<string, unknown>>;
  readonly settings: Readonly<Record<string, unknown>>;
}

function packageName(entry: unknown): string {
  if (typeof entry === "string") {
    return entry;
  }

  const source =
    typeof entry === "object" && entry !== null && "source" in entry
      ? entry.source
      : undefined;

  return typeof source === "string" ? source : JSON.stringify(entry);
}

function itemOf(path: string): Item | undefined {
  if (["AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"].includes(path)) {
    return { id: "instructions", group: "Instructions", label: "Instructions" };
  }

  const [folder, name] = path.split("/");

  const named = {
    Skills: "skills",
    Prompts: "prompts",
    Extensions: "extensions",
  };

  for (const [group, at] of Object.entries(named)) {
    if (folder === at && name !== undefined) {
      const label = name.replace(/\.(md|ts|js)$/, "");

      return { id: `${at}/${label}`, group: group as Group, label };
    }
  }

  return undefined;
}

async function jsonFile(
  file: File | undefined,
): Promise<Readonly<Record<string, unknown>>> {
  if (file === undefined) {
    return {};
  }

  try {
    const value: unknown = JSON.parse(await file.text());

    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function pickedOf(chosen: readonly File[]): Promise<Picked> {
  const files = new Map(
    chosen
      .map((file) => {
        const path = file.webkitRelativePath.split("/").slice(1).join("/");

        return [path, file] as const;
      })
      .filter(([path]) => profilePath(path)),
  );

  const items = new Map<string, Item>();

  for (const path of files.keys()) {
    const item = itemOf(path);

    if (item !== undefined) {
      items.set(item.id, item);
    }
  }

  const { packages, ...settings } = await jsonFile(files.get("settings.json"));
  const listed = Array.isArray(packages) ? (packages as unknown[]) : [];

  for (const entry of listed) {
    const name = packageName(entry);

    items.set(`package/${name}`, {
      id: `package/${name}`,
      group: "Packages",
      label: name,
    });
  }

  const mcp = (await jsonFile(files.get("mcp.json")))["mcpServers"];

  const mcpServers =
    typeof mcp === "object" && mcp !== null
      ? (mcp as Record<string, unknown>)
      : {};

  for (const name of Object.keys(mcpServers)) {
    items.set(`mcp/${name}`, {
      id: `mcp/${name}`,
      group: "MCP servers",
      label: name,
    });
  }

  return {
    files,
    items: [...items.values()],
    packages: listed,
    mcpServers,
    settings,
  };
}

// The picked folder's files without what the person left out, with
// settings.json and mcp.json rewritten to match.
async function filesToImport(
  picked: Picked,
  left: ReadonlySet<string>,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};

  const encode = (text: string): string =>
    base64(new TextEncoder().encode(text));

  for (const [path, file] of picked.files) {
    const item = itemOf(path);

    if (
      path === "settings.json" ||
      path === "mcp.json" ||
      (item !== undefined && left.has(item.id))
    ) {
      continue;
    }

    files[path] = base64(new Uint8Array(await file.arrayBuffer()));
  }

  const packages = picked.packages.filter(
    (entry) => !left.has(`package/${packageName(entry)}`),
  );

  if (picked.files.has("settings.json")) {
    files["settings.json"] = encode(
      JSON.stringify({ ...picked.settings, packages }, null, 2),
    );
  }

  const mcpServers = Object.fromEntries(
    Object.entries(picked.mcpServers).filter(
      ([name]) => !left.has(`mcp/${name}`),
    ),
  );

  if (Object.keys(mcpServers).length > 0) {
    files["mcp.json"] = encode(JSON.stringify({ mcpServers }, null, 2));
  }

  return files;
}

type Choice = "folder" | "git" | "clean";

// Brings an existing Pi setup into the person's default Profile, item by
// item, or starts one from a repository (ADR 0063).
export function ProfileStep({
  profiles,
  onImported,
}: {
  readonly profiles: readonly Profile[];
  readonly onImported: () => void;
}): ReactElement {
  const [choice, setChoice] = useState<Choice>("folder");
  const [picked, setPicked] = useState<Picked>();
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());
  const [url, setUrl] = useState("");
  const [state, setState] = useState<{ error?: string; done?: string }>({});

  const target = profiles.find(({ isDefault }) => isDefault);

  const toggle = (id: string): void => {
    const next = new Set(left);

    if (!next.delete(id)) {
      next.add(id);
    }

    setLeft(next);
  };

  const run = (action: () => Promise<string>): void => {
    setState({});

    action().then(
      (done) => {
        setState({ done });
        onImported();
      },
      (reason: unknown) => {
        setState({
          error: reason instanceof Error ? reason.message : String(reason),
        });
      },
    );
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
                    await api(
                      `/api/profiles/${encodeURIComponent(target.id)}/files`,
                      {
                        files: await filesToImport(picked, left),
                      },
                    );

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
                const response = await api("/api/profiles/import", { url });
                const made = (await response.json()) as Profile;

                await api(
                  `/api/profiles/${encodeURIComponent(made.id)}/default`,
                  {},
                );

                return `Made ${made.name} your default Profile.`;
              });
            }}
          >
            <input
              aria-label="Repository address"
              required
              value={url}
              placeholder="https://github.com/you/dotfiles.git"
              onChange={(event) => {
                setUrl(event.target.value);
              }}
              className={cn(fieldClass, "min-w-60 flex-1")}
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
      {state.done !== undefined && (
        <p role="status" className="text-label text-done">
          {state.done}
        </p>
      )}
      {state.error !== undefined && (
        <p role="alert" className="text-label text-failed">
          {state.error}
        </p>
      )}
    </div>
  );
}
