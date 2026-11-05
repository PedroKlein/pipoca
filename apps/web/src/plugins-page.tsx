import type { PluginInfo, SettingSpec, SettingValue } from "@pipoca/protocol";
import {
  Badge,
  Button,
  Card,
  cardClass,
  cn,
  ErrorText,
  Field,
  fieldClass,
  Icon,
  PageTitle,
  plural,
  Section,
  Segmented,
  Select,
  Switch,
  useConfirm,
} from "@pipoca/ui";
import { ok } from "@pipoca/plugins/web";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { api, send } from "./api";
import { usePlugins } from "./hooks";
import { settingsOf } from "./plugin-settings";
import { webPartError } from "./plugins";
import { settingsPageClass } from "./page-class";

export function PluginsPage(): ReactElement {
  const { value: plugins, reload } = usePlugins();
  const [installing, setInstalling] = useState(false);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState<"all" | "updates">("all");

  const updates = plugins.filter(
    ({ updateAvailable }) => updateAvailable === true,
  );

  const words = query.trim().toLowerCase();

  const listed = (shown === "all" ? plugins : updates).filter(
    ({ title, description }) =>
      `${title} ${description}`.toLowerCase().includes(words),
  );

  return (
    <div id="plugins-page" className={settingsPageClass}>
      <PageTitle
        description="Features for everyone on this server. A plugin with settings adds its own page to this menu."
        actions={
          !installing && (
            <Button
              onClick={() => {
                setInstalling(true);
              }}
            >
              Install from git
            </Button>
          )
        }
      >
        Plugins
      </PageTitle>
      {plugins.some(waitsForRestart) && <Restart />}
      {installing && (
        <Install
          onInstalled={reload}
          onClose={() => {
            setInstalling(false);
          }}
        />
      )}
      <div className="mt-6 flex flex-wrap items-center gap-2.5">
        <label className="flex h-9.5 min-w-60 flex-1 items-center gap-2 rounded-md border border-line bg-elevated px-3 focus-within:border-line-strong">
          <Icon name="search" />
          <input
            type="search"
            value={query}
            aria-label="Search plugins"
            placeholder="Search plugins"
            className="flex-1 bg-transparent text-ui outline-none"
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </label>
        <Segmented
          label="Show"
          value={shown}
          onChange={setShown}
          options={[
            { value: "all", label: `Installed · ${String(plugins.length)}` },
            { value: "updates", label: `Updates · ${String(updates.length)}` },
          ]}
        />
      </div>
      <ul aria-label="Plugins" className="mt-6 grid gap-3 md:grid-cols-2">
        {listed.map((plugin) => (
          <PluginCard key={plugin.id} plugin={plugin} onChange={reload} />
        ))}
      </ul>
      {listed.length === 0 && (
        <p className="mt-2 text-label text-fg-dim">
          {shown === "updates" && words === ""
            ? "Every plugin installed from git is up to date."
            : "No plugin matches."}
        </p>
      )}
      <p className="mt-6 text-caption text-fg-dim">
        Turning a plugin on or off applies when the server restarts, to open
        pages after a reload, and to Sessions the next time they start.
      </p>
    </div>
  );
}

function PluginCard({
  plugin,
  onChange,
}: {
  readonly plugin: PluginInfo;
  readonly onChange: () => void;
}): ReactElement {
  const failure = webPartError(plugin.id);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const installed = plugin.source === "installed";
  const hasSettings = Object.keys(plugin.settings ?? {}).length > 0;
  const [ask, asking] = useConfirm();

  const run = (change: () => Promise<string | undefined>): void => {
    change().then(
      (said) => {
        setError(undefined);
        setNote(said);
        onChange();
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  const turn = (): void => {
    const trusted = plugin.turnedOn
      ? Promise.resolve(true)
      : ask({
          title: `Turn on ${plugin.title}?`,
          description: trustQuestion(plugin),
          confirm: "Turn on",
        });

    void trusted.then((yes) => {
      if (!yes) {
        return;
      }

      run(async () => {
        await send(`/api/plugins/${plugin.id}`, "PATCH", {
          enabled: !plugin.turnedOn,
          digest: plugin.digest,
        });

        return undefined;
      });
    });
  };

  const update = (): void => {
    run(async () => {
      const response = await send(`/api/plugins/${plugin.id}`, "PATCH", {
        update: true,
      });

      const next = (await response.json()) as PluginInfo;

      if (next.installedFrom?.pinned === plugin.installedFrom?.pinned) {
        return "It already has the newest version.";
      }

      const added = (next.capabilities ?? []).filter(
        (capability) => !(plugin.capabilities ?? []).includes(capability),
      );

      return plugin.turnedOn && !next.turnedOn
        ? `Its newest version asks for more${added.length > 0 ? `, ${added.join(", ")}` : ""}, so it stays off until you turn it on again.`
        : undefined;
    });
  };

  const remove = (): void => {
    void ask({
      title: `Remove ${plugin.title} from this server?`,
      confirm: "Remove",
      danger: true,
    }).then((yes) => {
      if (!yes) {
        return;
      }

      run(async () => {
        await send(`/api/plugins/${plugin.id}`, "DELETE");

        return undefined;
      });
    });
  };

  const reset = (): void => {
    void ask({
      title: `Reset ${plugin.title}'s data?`,
      description:
        "Its tables are dropped and made again empty, and everything it kept there is gone.",
      confirm: "Reset data",
      danger: true,
    }).then((yes) => {
      if (!yes) {
        return;
      }

      run(async () => {
        await send(`/api/plugin-resets/${plugin.id}`, "POST");

        return undefined;
      });
    });
  };

  const meta = [
    installed ? "Installed" : "Built in",
    plugin.version,
    plugin.state === "off" && !switchesAtRestart(plugin) ? "Off" : undefined,
  ].filter((part) => part !== undefined);

  return (
    <li
      aria-label={plugin.title}
      className={cn(
        cardClass,
        "flex flex-col gap-2 p-4",
        open && "md:col-span-2",
      )}
    >
      <div className="flex items-start gap-3">
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-ui font-medium text-fg-strong">
          {plugin.title}
          {plugin.state === "failed" && <Badge state="failed">Failed</Badge>}
          {switchesAtRestart(plugin) && (
            <Badge state="waiting">
              {plugin.state === "on" ? "On" : "Off"} until restart
            </Badge>
          )}
          {plugin.updated === true && <Badge state="waiting">Updated</Badge>}
          {plugin.updateAvailable === true && plugin.updated !== true && (
            <Badge>Update</Badge>
          )}
        </span>
        <span
          title={
            installed
              ? undefined
              : "The server's config file turns built-in plugins on and off"
          }
        >
          <Switch
            label="On"
            labelHidden
            checked={installed ? plugin.turnedOn : plugin.state === "on"}
            disabled={!installed}
            onChange={turn}
          />
        </span>
      </div>
      <p className="text-label text-fg-dim">{plugin.description}</p>
      {installed && (
        <p className="break-all font-mono text-mono-sm text-fg-dim">
          {plugin.installedFrom === undefined
            ? "written in place"
            : `${plugin.installedFrom.url} at ${shortPin(plugin.installedFrom.pinned)}`}
        </p>
      )}
      <div className="mt-auto flex flex-wrap items-center gap-x-1.5 gap-y-1 text-caption text-fg-dim">
        <span>{meta.join(" · ")}</span>
        {hasSettings && (
          <>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              aria-expanded={open}
              className="cursor-pointer text-fg underline underline-offset-2"
              onClick={() => {
                setOpen(!open);
              }}
            >
              Settings
            </button>
          </>
        )}
        {installed && (
          <span className="ml-auto flex gap-1">
            {plugin.installedFrom !== undefined && (
              <Button variant="ghost" onClick={update}>
                Update
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={remove}
              disabled={plugin.state === "on"}
              title={
                plugin.state === "on"
                  ? "Turn it off and restart the server to remove it"
                  : undefined
              }
            >
              Remove
            </Button>
          </span>
        )}
      </div>
      {(pendingNote(plugin) ?? note) !== undefined && (
        <p className="text-label text-fg-dim">{pendingNote(plugin) ?? note}</p>
      )}
      <ErrorText size="caption">{error}</ErrorText>
      {plugin.error !== undefined && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-label text-failed">
            It failed to start: {plugin.error}
          </p>
          {plugin.resettable === true && (
            <Button variant="ghost" onClick={reset}>
              Reset data
            </Button>
          )}
        </div>
      )}
      {failure !== undefined && (
        <p className="text-label text-failed">
          Its web part didn&apos;t load: {failure}
        </p>
      )}
      {open && plugin.settings !== undefined && (
        <SettingsForm
          plugin={plugin}
          settings={plugin.settings}
          onChange={onChange}
        />
      )}
      {asking}
    </li>
  );
}

// A failed plugin shows its error instead.
function switchesAtRestart(plugin: PluginInfo): boolean {
  return (
    plugin.source === "installed" &&
    plugin.state !== "failed" &&
    plugin.turnedOn !== (plugin.state === "on")
  );
}

function waitsForRestart(plugin: PluginInfo): boolean {
  return (
    switchesAtRestart(plugin) ||
    (plugin.source === "installed" &&
      plugin.updated === true &&
      plugin.turnedOn)
  );
}

function shortPin(pinned: string): string {
  return pinned.startsWith("sha256:")
    ? pinned.slice(0, "sha256:".length + 12)
    : pinned.slice(0, 12);
}

// Installing only fetches the plugin; none of its code runs until it is
// turned on (ADR 0022).
function Install({
  onInstalled,
  onClose,
}: {
  readonly onInstalled: () => void;
  readonly onClose: () => void;
}): ReactElement {
  const [error, setError] = useState<string>();
  const [installed, setInstalled] = useState<string>();
  const [installing, setInstalling] = useState(false);

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();

    const form = event.currentTarget;
    const url = new FormData(form).get("url");

    setInstalling(true);
    setInstalled(undefined);

    api("/api/plugins", { url: typeof url === "string" ? url.trim() : "" })
      .then(async (response) => (await response.json()) as PluginInfo)
      .then(
        (plugin) => {
          setError(undefined);

          setInstalled(
            `Installed ${plugin.title}, turned off. It's listed below.`,
          );

          form.reset();
          onInstalled();
        },
        (reason: unknown) => {
          setError(reason instanceof Error ? reason.message : String(reason));
        },
      )
      .finally(() => {
        setInstalling(false);
      });
  };

  return (
    <Section
      title="Install a plugin"
      description="It installs turned off, so none of its code runs yet"
    >
      <form
        onSubmit={submit}
        aria-label="Install a plugin"
        className="flex flex-col gap-2"
      >
        <label className="sr-only" htmlFor="plugin-url">
          Install from a git repository or a .tgz URL
        </label>
        <div className="flex gap-2">
          <input
            id="plugin-url"
            name="url"
            required
            placeholder="https://github.com/you/plugin.git#v1.0.0"
            className={cn(fieldClass, "flex-1 font-mono text-mono-sm")}
          />
          <Button variant="primary" type="submit" disabled={installing}>
            {installing ? "Installing…" : "Install"}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        <p className="text-caption text-fg-dim">
          A git repository or a .tgz URL. A branch, tag or commit after # pins
          it.
        </p>
        <ErrorText size="caption">{error}</ErrorText>
        {installed !== undefined && (
          <p role="status" className="text-caption text-fg-dim">
            {installed}
          </p>
        )}
      </form>
    </Section>
  );
}

// What turning a plugin on lets it do, since its code runs unsandboxed.
function trustQuestion(plugin: PluginInfo): string {
  const declared = plugin.capabilities ?? [];
  const parts = plugin.parts ?? {};

  return [
    `Its code runs inside the Pipoca server, with the server's access. It asks for ${declared.length > 0 ? declared.join(", ") : "nothing more"}.`,
    ...(parts.web === undefined
      ? []
      : ["Its web part runs in the page of everyone who opens Pipoca."]),
    ...(parts.session === undefined
      ? []
      : [
          plugin.ownSessionsOnly === true
            ? "Its Session part runs in its own Sessions, on the machines that run them."
            : "Its Session part runs in every Session, on every machine that runs one, laptops included.",
        ]),
    "Turn on only plugins you trust.",
  ].join(" ");
}

// Sessions on the server's own runner stop with it, so a restart asks first
// while one is mid-turn (ADR 0022). The page reloads once the server answers
// again.
function Restart(): ReactElement {
  const [state, setState] = useState<"idle" | "restarting">("idle");
  const [error, setError] = useState<string>();
  const [ask, asking] = useConfirm();

  const restart = async (force: boolean): Promise<void> => {
    const before = await startedAt();

    const response = await fetch("/api/restart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force }),
    });

    if (response.status === 409) {
      const { sessions } = (await response.json()) as { sessions: number };

      if (
        await ask({
          title: "Restart anyway?",
          description: `${plural(sessions, "Session is", "Sessions are")} mid-turn on the server's own runner and will be interrupted.`,
          confirm: "Restart",
          danger: true,
        })
      ) {
        await restart(true);
      }

      return;
    }

    await ok(Promise.resolve(response));
    setState("restarting");
    await back(before);
    location.reload();
  };

  return (
    <Card
      padding="none"
      className="mb-4 flex flex-wrap items-center gap-3 p-4 text-ui"
    >
      <span className="text-fg">
        {state === "restarting"
          ? "Restarting the server…"
          : "Some changes wait for the server to restart."}
      </span>
      {state === "idle" && (
        <Button
          onClick={() => {
            restart(false).catch((reason: unknown) => {
              setError(
                reason instanceof Error ? reason.message : String(reason),
              );
            });
          }}
        >
          Restart now
        </Button>
      )}
      <ErrorText size="caption">{error}</ErrorText>
      {asking}
    </Card>
  );
}

// The old server keeps answering while it stops its Sessions, so this waits
// for one that started later.
async function back(before: string | undefined): Promise<void> {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 500));

    const now = await startedAt();

    if (now !== undefined && now !== before) {
      return;
    }
  }
}

async function startedAt(): Promise<string | undefined> {
  return fetch("/healthz").then(
    async (response) =>
      response.ok
        ? ((await response.json()) as { started: string }).started
        : undefined,
    () => undefined,
  );
}

function pendingNote(plugin: PluginInfo): string | undefined {
  if (switchesAtRestart(plugin)) {
    return plugin.turnedOn
      ? "It turns on when the server restarts."
      : "It turns off when the server restarts.";
  }

  return plugin.updated === true && plugin.turnedOn
    ? "Its newest version runs when the server restarts."
    : undefined;
}

function SettingsForm({
  plugin,
  settings,
  onChange,
}: {
  readonly plugin: PluginInfo;
  readonly settings: Readonly<Record<string, SettingSpec>>;
  readonly onChange: () => void;
}): ReactElement {
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setSaved(false);

    send(`/api/plugins/${plugin.id}`, "PATCH", {
      settings: settingsOf(settings, new FormData(event.currentTarget)),
    }).then(
      () => {
        setError(undefined);
        setSaved(true);
        onChange();
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  return (
    <form
      onSubmit={submit}
      aria-label={`${plugin.title} settings`}
      className="flex flex-col gap-4 rounded-md bg-panel p-4"
    >
      {Object.entries(settings).map(([name, spec]) => (
        <SettingField
          key={name}
          name={name}
          spec={spec}
          value={plugin.values[name] ?? spec.default}
        />
      ))}
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
  );
}

function SettingField({
  name,
  spec,
  value,
}: {
  readonly name: string;
  readonly spec: SettingSpec;
  readonly value: SettingValue;
}): ReactElement {
  const label =
    spec.description === undefined
      ? spec.title
      : `${spec.title}. ${spec.description}`;

  switch (spec.type) {
    case "boolean":
      return (
        <label className="flex items-center gap-2 text-ui text-fg">
          <input name={name} type="checkbox" defaultChecked={value === true} />
          {label}
        </label>
      );
    case "choice":
      return (
        <Field label={label}>
          <Select name={name} defaultValue={String(value)}>
            {spec.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
      );
    case "strings":
      return (
        <Field label={`${label} One per line.`}>
          <textarea
            name={name}
            rows={3}
            defaultValue={Array.isArray(value) ? value.join("\n") : ""}
            className={cn(
              fieldClass,
              "min-h-20 resize-y font-mono text-mono-sm",
            )}
          />
        </Field>
      );
    case "number":
      return (
        <Field label={label}>
          <input
            name={name}
            type="number"
            required
            step="any"
            defaultValue={String(value)}
            {...(spec.min !== undefined && { min: spec.min })}
            {...(spec.max !== undefined && { max: spec.max })}
            className={cn(fieldClass, "w-40")}
          />
        </Field>
      );
    case "string":
      return (
        <Field label={label}>
          <input
            name={name}
            defaultValue={String(value)}
            className={fieldClass}
          />
        </Field>
      );
  }
}
