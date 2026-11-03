import { json, useLoaded } from "@pipoca/plugins/web";
import type {
  ListedProfile,
  PiPackage,
  Profile,
  ProfileContent,
  ProfileSource,
} from "@pipoca/protocol";
import {
  Badge,
  Button,
  cn,
  Field,
  FileButton,
  fieldClass,
  Icon,
  ListInput,
  PageTitle,
  Picker,
  Section,
} from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { api, send } from "./api";
import {
  type Kind,
  KindFiles,
  messageOf,
  NamedFiles,
  type OneFile,
  upload,
} from "./profile-files";
import { settingsPageClass } from "./page-class";
import { PluginBoundary } from "./plugin-boundary";
import { enabledPlugins, pluginContext } from "./plugins";

// A package is a source such as npm:name, or a JSON object with Pi's
// filters.
function packageText(pkg: PiPackage): string {
  return typeof pkg === "string" ? pkg : JSON.stringify(pkg);
}

function packageOf(text: string): unknown {
  return text.startsWith("{") ? JSON.parse(text) : text;
}

// Not Profile ids, so no Profile's page can take them.
const layerHashes = { base: ":base", defaults: ":defaults" } as const;

type Layer = keyof typeof layerHashes;

const layerNames: Readonly<Record<Layer, string>> = {
  base: "Server base",
  defaults: "My defaults",
};

const chipClass =
  "flex h-8 items-center gap-1.5 rounded-full border border-line bg-elevated px-3 text-ui text-fg hover:bg-hover aria-[current=page]:border-fg-strong aria-[current=page]:bg-fg-strong aria-[current=page]:text-bg";

export function ProfilesPage({
  profiles,
  admin,
  selected,
  onChange,
}: {
  readonly profiles: readonly Profile[];
  readonly admin: boolean;
  readonly selected: string;
  readonly onChange: () => void;
}): ReactElement {
  const [id = "", tab = "overview"] = selected.split("/");
  const profile = profiles.find((each) => each.id === id);

  const layer = (Object.keys(layerHashes) as Layer[]).find(
    (each) => layerHashes[each] === id,
  );

  // The editor starts again when its files change, so it doesn't keep this.
  const [savedId, setSavedId] = useState<string>();

  return (
    <div id="profiles-page" className={settingsPageClass}>
      <PageTitle description="How Pi behaves in a Session: what it knows, the skills and tools it has. A Profile is a Pi agent folder, like your ~/.pi/agent. Every Profile sits on the Server base and your My defaults. Edits reach a Session the next time it starts.">
        Profiles
      </PageTitle>
      <nav aria-label="Profiles" className="flex flex-wrap gap-2">
        {profiles.map((each) => (
          <a
            key={each.id}
            href={`#profiles/${each.id}`}
            aria-current={each.id === id ? "page" : undefined}
            className={chipClass}
          >
            {each.name}
            {each.isDefault && <Badge state="done">Default</Badge>}
            {each.ownerId === null && <Badge state="offline">Shared</Badge>}
            {each.source && <Badge state="offline">Synced</Badge>}
          </a>
        ))}
        {(Object.keys(layerHashes) as Layer[]).map((each) => (
          <a
            key={each}
            href={`#profiles/${layerHashes[each]}`}
            aria-current={id === layerHashes[each] ? "page" : undefined}
            className={chipClass}
          >
            {each === "base" && !admin && (
              <Icon name="lock" className="size-3.5" />
            )}
            {layerNames[each]}
          </a>
        ))}
        <a
          href="#profiles/new"
          aria-current={selected === "new" ? "page" : undefined}
          className={cn(chipClass, "border-dashed text-fg-dim")}
        >
          <Icon name="plus" className="size-4" />
          New Profile
        </a>
      </nav>
      {profile && (
        <ProfileTabs
          url={`/api/profiles/${profile.id}/files`}
          hash={profile.id}
          tab={tab}
          overview={
            <>
              {profile.source && (
                <Synced
                  profile={profile}
                  source={profile.source}
                  onChange={onChange}
                />
              )}
              <Editor
                key={`${profile.id}:${JSON.stringify(profile.packages)}:${profile.buildsOn ?? ""}`}
                profile={profile}
                profiles={profiles}
                saved={savedId === profile.id}
                onSaved={() => {
                  setSavedId(profile.id);
                }}
                onChange={onChange}
              />
              <ProfileParts profileId={profile.id} />
            </>
          }
        />
      )}
      {layer && (
        <ProfileTabs
          key={layer}
          url={`/api/${layer}/files`}
          hash={layerHashes[layer]}
          tab={tab}
          overview={<LayerEditor layer={layer} />}
        />
      )}
      {selected === "new" && (
        <Editor key="new" profiles={profiles} onChange={onChange} />
      )}
      {selected === "" && <Import onChange={onChange} />}
    </div>
  );
}

// What plugins add to a Profile's page, such as its own logins (ADR 0063).
function ProfileParts({
  profileId,
}: {
  readonly profileId: string;
}): ReactElement {
  return (
    <>
      {enabledPlugins().map(({ name, settingsParts }) => {
        const Part = settingsParts?.Profile;

        return (
          Part && (
            <PluginBoundary key={name} name={name}>
              <Part context={pluginContext(name)} profileId={profileId} />
            </PluginBoundary>
          )
        );
      })}
    </>
  );
}

function Editor({
  profile,
  profiles,
  saved = false,
  onSaved,
  onChange,
}: {
  readonly profile?: Profile;
  readonly profiles: readonly Profile[];
  readonly saved?: boolean;
  readonly onSaved?: () => void;
  readonly onChange: () => void;
}): ReactElement {
  const [error, setError] = useState<string>();

  const [packages, setPackages] = useState<readonly string[]>(() =>
    (profile?.packages ?? []).map(packageText),
  );

  const [buildsOn, setBuildsOn] = useState(profile?.buildsOn ?? null);

  const run = (action: () => Promise<void>): void => {
    action().then(
      () => {
        setError(undefined);
        onChange();
      },
      (reason: unknown) => {
        setError(messageOf(reason));
      },
    );
  };

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const text = (name: string): string => {
      const value = form.get(name);

      return typeof value === "string" ? value : "";
    };

    run(async () => {
      const body = {
        name: text("name"),
        packages: packages.map(packageOf),
        buildsOn,
      };

      if (profile) {
        // Only what changed here, so a file edited below or by hand since
        // isn't written back as it was.
        const changed = Object.fromEntries(
          Object.entries(body).filter(
            ([key, value]) =>
              JSON.stringify(value) !==
              JSON.stringify(profile[key as keyof typeof body]),
          ),
        );

        await send(`/api/profiles/${profile.id}`, "PUT", changed);
        onSaved?.();

        return;
      }

      const created = (await (
        await api("/api/profiles", {
          ...body,
          shared: form.get("shared") === "on",
        })
      ).json()) as Profile;

      location.hash = `profiles/${created.id}`;
    });
  };

  return (
    <Section title={profile ? profile.name : "New Profile"}>
      <form
        onSubmit={submit}
        className="flex flex-col gap-4 rounded-lg border border-line bg-elevated shadow-xs p-5"
      >
        <Field label="Name">
          <input
            name="name"
            required
            defaultValue={profile?.name ?? ""}
            className={fieldClass}
          />
        </Field>
        {!profile && (
          <label className="flex items-center gap-2 text-ui text-fg">
            <input type="checkbox" name="shared" />
            Shared with everyone. Only admins can change it.
          </label>
        )}
        <BuildsOn
          profile={profile}
          profiles={profiles}
          value={buildsOn}
          onChange={setBuildsOn}
        />
        <ListInput
          label="Pi packages"
          values={packages}
          placeholder="npm:pi-subagents, git:… or a path, then Enter"
          onChange={setPackages}
        />
        <div className="flex flex-wrap items-center gap-2">
          {!profile?.source && (
            <Button variant="primary" type="submit">
              {profile ? "Save" : "Create Profile"}
            </Button>
          )}
          {profile && !profile.isDefault && (
            <Button
              onClick={() => {
                run(async () => {
                  await api(`/api/profiles/${profile.id}/default`, {});
                });
              }}
            >
              Make default
            </Button>
          )}
          {profile && (
            <a
              href={`/api/profiles/${profile.id}/export`}
              download
              className="inline-flex h-control items-center rounded-md px-3 text-ui font-medium text-fg-dim hover:bg-hover hover:text-fg"
            >
              Export
            </a>
          )}
          {profile && !profile.isDefault && (
            <Button
              variant="danger"
              onClick={() => {
                if (!confirm(`Delete the Profile "${profile.name}"?`)) {
                  return;
                }

                run(async () => {
                  await send(`/api/profiles/${profile.id}`, "DELETE");
                  location.hash = "profiles";
                });
              }}
            >
              Delete
            </Button>
          )}
          <p role="status" className="text-caption">
            {error !== undefined ? (
              <span className="text-failed">{error}</span>
            ) : (
              saved && <span className="text-fg-dim">Saved</span>
            )}
          </p>
        </div>
      </form>
    </Section>
  );
}

// The base Profile's packages and AGENTS.md, which every Session loads under
// its own Profile's (ADR 0044).
const tabs: readonly (readonly [string, string])[] = [
  ["overview", "Overview"],
  ["instructions", "Instructions"],
  ["skills", "Skills"],
  ["prompts", "Prompts"],
  ["extensions", "Extensions"],
  ["mcp", "MCP"],
  ["models", "Models"],
  ["settings", "Settings"],
  ["files", "Files"],
];

const kinds: Readonly<Record<string, Kind>> = {
  skills: {
    title: "Skills",
    about:
      "A skill is a folder with a SKILL.md. Pi lists each skill's name and description to the model, which reads the rest when a task needs it. /skill:name runs one.",
    nameOf: (path) => /^skills\/(?:.+\/)?([^/]+)\/SKILL\.md$/.exec(path)?.[1],
    newPath: (name) => `skills/${name}/SKILL.md`,
    template: (name) =>
      `---\nname: ${name}\ndescription: What it does, and when to use it.\n---\n\n# ${name}\n`,
    placeholder: "review",
    folder: "skills/",
  },
  prompts: {
    title: "Prompts",
    about:
      "A prompt template becomes a slash command named after its file, so prompts/review.md is /review. $1, $@ and ${1:-default} take its arguments.",
    nameOf: (path) => /^prompts\/([^/]+)\.md$/.exec(path)?.[1],
    newPath: (name) => `prompts/${name}.md`,
    template: () =>
      '---\ndescription: What the command does\nargument-hint: "[focus]"\n---\nDo the task. Focus on ${1:-correctness}.\n',
    placeholder: "review",
    folder: "prompts/",
  },
  extensions: {
    title: "Extensions",
    about:
      "An extension is a TypeScript file, or a folder with an index.ts, that adds tools, commands or model providers. One that needs npm dependencies goes in Overview as a Pi package instead.",
    nameOf: (path) =>
      /^extensions\/([^/]+?)(?:\.[jt]s|\/index\.[jt]s)$/.exec(path)?.[1],
    newPath: (name) => `extensions/${name}.ts`,
    template: (name) =>
      `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\n\nexport default function (pi: ExtensionAPI) {\n  pi.registerCommand("${name}", {\n    description: "Say hello",\n    handler: async (_args, ctx) => {\n      ctx.ui.notify("Hello!", "info");\n    },\n  });\n}\n`,
    placeholder: "hello",
    folder: "extensions/",
  },
  files: {
    title: "Files",
    about:
      "Every file in the folder, as Pi reads them from ~/.pi/agent, such as themes/ and keybindings.json for Pi in a terminal. Uploading a folder such as ~/.pi/agent leaves out logins and history.",
    nameOf: (path) => path,
    newPath: (path) => path,
    template: () => "",
    placeholder: "skills/review/SKILL.md",
  },
};

const namedFiles: Readonly<
  Record<string, { readonly title: string; readonly files: readonly OneFile[] }>
> = {
  instructions: {
    title: "Instructions",
    files: [
      {
        path: "AGENTS.md",
        about:
          "Instructions for every Session, next to the AGENTS.md files of the repository it works in.",
        example: "Answer briefly. Run the tests before saying something works.",
      },
      {
        path: "APPEND_SYSTEM.md",
        about: "Added to the end of Pi's system prompt.",
        example: "Always reply in English.",
      },
      {
        path: "SYSTEM.md",
        about:
          "Replaces Pi's whole system prompt. Leave it empty unless you mean that.",
        example: "You are a careful coding assistant…",
      },
    ],
  },
  mcp: {
    title: "MCP servers",
    files: [
      {
        path: "mcp.json",
        about:
          "MCP servers every Session can use. ${NAME} in a value reads an Environment secret.",
        example: `{\n  "mcpServers": {\n    "docs": {\n      "url": "https://example.com/mcp",\n      "headers": { "Authorization": "Bearer \${DOCS_TOKEN}" }\n    }\n  }\n}`,
      },
    ],
  },
  models: {
    title: "Models",
    files: [
      {
        path: "models.json",
        about:
          "Endpoints that speak an API Pi knows, such as Ollama or a proxy, and overrides for existing models. Keys can name an Environment secret as $NAME.",
        example: `{\n  "providers": {\n    "ollama": {\n      "baseUrl": "http://localhost:11434/v1",\n      "api": "openai-completions",\n      "apiKey": "ollama",\n      "models": [{ "id": "qwen2.5-coder:7b" }]\n    }\n  }\n}`,
      },
    ],
  },
  settings: {
    title: "Settings",
    files: [
      {
        path: "settings.json",
        about:
          "Pi's settings, such as defaultProvider, defaultModel and defaultThinkingLevel. Its packages are the ones in Overview.",
        example: `{\n  "defaultThinkingLevel": "medium"\n}`,
      },
    ],
  },
};

function ProfileTabs({
  url,
  hash,
  tab,
  overview,
}: {
  readonly url: string;
  readonly hash: string;
  readonly tab: string;
  readonly overview: ReactElement;
}): ReactElement {
  const kind = kinds[tab];
  const named = namedFiles[tab];

  return (
    <>
      <nav
        aria-label="Profile"
        className="mt-6 flex gap-1 overflow-x-auto border-b border-line"
      >
        {tabs.map(([key, label]) => (
          <a
            key={key}
            href={`#profiles/${hash}/${key}`}
            aria-current={key === tab ? "page" : undefined}
            className="-mb-px shrink-0 border-b-2 border-transparent px-2 py-2 text-ui text-fg-dim hover:text-fg aria-[current=page]:border-accent aria-[current=page]:text-fg-strong"
          >
            {label}
          </a>
        ))}
      </nav>
      {(tab === "overview" || (!kind && !named)) && overview}
      {kind && <KindFiles key={`${url}:${tab}`} url={url} kind={kind} />}
      {named && (
        <NamedFiles
          key={`${url}:${tab}`}
          url={url}
          title={named.title}
          files={named.files}
        />
      )}
    </>
  );
}

// What a Profile builds on, from the bottom: the base, the person's My
// defaults and, if they pick one, another Profile (ADR 0063).
function BuildsOn({
  profile,
  profiles,
  value,
  onChange,
}: {
  readonly profile: Profile | undefined;
  readonly profiles: readonly Profile[];
  readonly value: string | null;
  readonly onChange: (id: string | null) => void;
}): ReactElement {
  const shared = profile?.ownerId === null;

  const options = profiles.filter(
    ({ id, ownerId }) => id !== profile?.id && (!shared || ownerId === null),
  );

  const step = <Icon name="chevron-right" className="size-3.5 text-fg-dim" />;

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-ui">
      <span className="mr-1 text-fg-dim">Builds on</span>
      <a href={`#profiles/${layerHashes.base}`} className={chipClass}>
        {layerNames.base}
      </a>
      {step}
      <a href={`#profiles/${layerHashes.defaults}`} className={chipClass}>
        {layerNames.defaults}
      </a>
      {step}
      <Picker
        label="Builds on"
        options={[
          { value: "", label: "Nothing else" },
          ...options.map(({ id, name }) => ({ value: id, label: name })),
        ]}
        selected={[value ?? ""]}
        onChange={([id]) => {
          onChange(id === undefined || id === "" ? null : id);
        }}
      >
        {profiles.find(({ id }) => id === value)?.name ?? "Nothing else"}
      </Picker>
    </div>
  );
}

const layerAbout: Readonly<Record<Layer, string>> = {
  base: "Every Session on this server loads this under its own Profile, with the Profile's entries winning. Put provider extensions here so every Session can use their models. Only admins change it.",
  defaults:
    "Yours, under every Profile of yours and over the Server base. Put what you want in every Session here, such as your instructions and the providers you use.",
};

function LayerEditor({
  layer,
}: {
  readonly layer: Layer;
}): ReactElement | null {
  const { value: content, reload } = useLoaded(
    async () => json<ProfileContent>(fetch(`/api/${layer}`)),
    layer,
    { topics: ["profiles"] },
  );

  // The form starts again when the layer changes, so it doesn't keep this.
  const [saved, setSaved] = useState(false);

  return content ? (
    <LayerForm
      key={JSON.stringify(content.packages)}
      layer={layer}
      content={content}
      saved={saved}
      onSaved={() => {
        setSaved(true);
        reload();
      }}
    />
  ) : null;
}

function LayerForm({
  layer,
  content,
  saved,
  onSaved,
}: {
  readonly layer: Layer;
  readonly content: ProfileContent;
  readonly saved: boolean;
  readonly onSaved: () => void;
}): ReactElement {
  const [packages, setPackages] = useState<readonly string[]>(() =>
    content.packages.map(packageText),
  );

  const [error, setError] = useState<string>();

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();

    send(`/api/${layer}`, "PUT", { packages: packages.map(packageOf) }).then(
      () => {
        setError(undefined);
        onSaved();
      },
      (reason: unknown) => {
        setError(messageOf(reason));
      },
    );
  };

  return (
    <Section title={layerNames[layer]}>
      <form
        onSubmit={submit}
        className="flex flex-col gap-4 rounded-lg border border-line bg-elevated shadow-xs p-5"
      >
        <p className="text-caption text-fg-dim">{layerAbout[layer]}</p>
        <ListInput
          label="Pi packages"
          values={packages}
          placeholder="npm:pi-subagents, git:… or a path, then Enter"
          onChange={setPackages}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" type="submit">
            Save
          </Button>
          <p role="status" className="text-caption">
            {error !== undefined ? (
              <span className="text-failed">{error}</span>
            ) : (
              saved && <span className="text-fg-dim">Saved</span>
            )}
          </p>
        </div>
      </form>
    </Section>
  );
}

// A Profile that follows a folder in a repository (ADR 0063). It changes only
// when the repository does, so editing starts from a copy.
function Synced({
  profile,
  source,
  onChange,
}: {
  readonly profile: Profile;
  readonly source: ProfileSource;
  readonly onChange: () => void;
}): ReactElement {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const act = (action: () => Promise<void>): void => {
    setBusy(true);

    action().then(
      () => {
        setBusy(false);
        setError(undefined);
        onChange();
      },
      (reason: unknown) => {
        setBusy(false);
        setError(messageOf(reason));
      },
    );
  };

  return (
    <div
      aria-label="Synced from a repository"
      className="mt-6 flex flex-col gap-3 rounded-lg bg-hover p-4 text-label text-fg"
    >
      <p className="flex gap-2.5">
        <Icon name="lock" className="mt-0.5 size-4 shrink-0 text-fg-dim" />
        <span>
          Follows <span className="font-mono">{source.path}</span> in{" "}
          <span className="font-mono break-all">{source.url}</span> at{" "}
          <span className="font-mono">{source.commit.slice(0, 7)}</span>. It
          changes when the repository does, so make a copy to edit it, or build
          a Profile of your own on it.
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={busy}
          onClick={() => {
            act(async () => {
              await api(`/api/profiles/${profile.id}/sync`, {});
            });
          }}
        >
          Sync now
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            act(async () => {
              const copy = await json<Profile>(
                api(`/api/profiles/${profile.id}/copy`, {}),
              );

              location.hash = `profiles/${copy.id}`;
            });
          }}
        >
          Make a copy
        </Button>
        {error !== undefined && (
          <span role="alert" className="text-caption text-failed">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

function Import({ onChange }: { readonly onChange: () => void }): ReactElement {
  const [error, setError] = useState<string>();

  const [listed, setListed] = useState<{
    readonly url: string;
    readonly profiles: readonly ListedProfile[];
  }>();

  const imported = (action: () => Promise<Profile | undefined>): void => {
    action().then(
      (profile) => {
        setError(undefined);

        if (profile) {
          onChange();
          location.hash = `profiles/${profile.id}`;
        }
      },
      (reason: unknown) => {
        setError(messageOf(reason));
      },
    );
  };

  const fromFile = async (file: File): Promise<Profile> => {
    if (file.name.endsWith(".json")) {
      return json<Profile>(
        api("/api/profiles/import", JSON.parse(await file.text())),
      );
    }

    const name = file.name.replace(/\.(tar\.gz|tgz)$/, "");

    return json<Profile>(
      fetch(`/api/profiles/import?name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "content-type": "application/gzip" },
        body: file,
      }),
    );
  };

  const fromFolder = async (picked: readonly File[]): Promise<Profile> => {
    const name = picked[0]?.webkitRelativePath.split("/")[0] ?? "Imported";
    const profile = await json<Profile>(api("/api/profiles", { name }));

    await upload(`/api/profiles/${profile.id}/files`, picked, {
      picked: true,
    });

    return profile;
  };

  return (
    <Section title="Import a Profile">
      <div className="flex flex-col gap-4 rounded-lg border border-line bg-elevated shadow-xs p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-label font-medium text-fg">
              From a folder
            </span>
            <span className="text-caption text-fg-dim">
              Such as your ~/.pi/agent. Logins and Session history stay behind.
            </span>
          </div>
          <FileButton
            multiple
            {...{ webkitdirectory: "" }}
            onFiles={(picked) => {
              imported(async () => fromFolder(picked));
            }}
          >
            Choose a folder
          </FileButton>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-label font-medium text-fg">
            From an exported .tar.gz
          </span>
          <FileButton
            accept=".gz,.tgz,.json,application/gzip,application/json"
            onFiles={([file]) => {
              if (file) {
                imported(async () => fromFile(file));
              }
            }}
          >
            Choose a file
          </FileButton>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const url = new FormData(event.currentTarget).get("url");

            const repository = typeof url === "string" ? url.trim() : "";

            imported(async () => {
              const { profiles } = await json<{
                readonly profiles: readonly ListedProfile[];
              }>(api("/api/profiles/listed", { url: repository }));

              if (profiles.length > 0) {
                setListed({ url: repository, profiles });

                return undefined;
              }

              return json<Profile>(
                api("/api/profiles/import", { url: repository }),
              );
            });
          }}
          className="flex flex-col gap-1.5"
        >
          <Field label="From a git repository that holds a Profile folder">
            <span className="flex gap-2">
              <input
                name="url"
                required
                placeholder="https://github.com/me/pi-setup.git"
                className={cn(fieldClass, "flex-1")}
              />
              <Button type="submit">Import</Button>
            </span>
          </Field>
        </form>
        {listed && (
          <form
            aria-label="Profiles in the repository"
            onSubmit={(event) => {
              event.preventDefault();
              const paths = new FormData(event.currentTarget).getAll("path");

              imported(async () => {
                const { profiles } = await json<{
                  readonly profiles: readonly Profile[];
                }>(api("/api/profiles/import", { url: listed.url, paths }));

                setListed(undefined);

                const [first] = profiles;
                if (!first) {
                  throw new Error("Pick at least one Profile.");
                }

                return first;
              });
            }}
            className="flex flex-col gap-2"
          >
            <span className="text-label text-fg-dim">
              Its pipoca.json lists these. Each one you bring follows the
              repository from then on.
            </span>
            {listed.profiles.map(({ name, path }) => (
              <label key={path} className="flex items-center gap-2 text-ui">
                <input
                  type="checkbox"
                  name="path"
                  value={path}
                  defaultChecked
                />
                {name}
                <span className="font-mono text-mono-sm text-fg-dim">
                  {path}
                </span>
              </label>
            ))}
            <span>
              <Button variant="primary" type="submit">
                Bring them
              </Button>
            </span>
          </form>
        )}
        <p role="alert" className="text-caption text-failed">
          {error}
        </p>
      </div>
    </Section>
  );
}
