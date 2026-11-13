import { type PluginInfo, switchingWith } from "@pipoca/protocol";
import {
  Badge,
  Button,
  cardClass,
  cn,
  type ConfirmOptions,
  ErrorText,
  Switch,
  useConfirm,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { request } from "../../data/client";
import { useAction } from "../../data/hooks";
import { webPartError } from "../../plugins";
import { switchesAtRestart } from "./restart";

export function PluginCard({
  plugin,
  plugins,
}: {
  readonly plugin: PluginInfo;
  readonly plugins: readonly PluginInfo[];
}): ReactElement {
  const failure = webPartError(plugin.id);
  const [note, setNote] = useState<string>();
  const installed = plugin.source === "installed";
  const [ask, asking] = useConfirm();

  const change = useAction(async (work: () => Promise<string | undefined>) => {
    setNote(await work());
  });

  const error = change.error;

  const run = (work: () => Promise<string | undefined>): void => {
    void change.run(work);
  };

  const turn = (): void => {
    run(async () => {
      await turnPlugin(plugin, plugins, ask);

      return undefined;
    });
  };

  const update = (): void => {
    run(async () => {
      const next = await request("plugins.update", {
        params: { plugin: plugin.id },
        body: { update: true },
      });

      if (next.installedFrom?.pinned === plugin.installedFrom?.pinned) {
        return "It already has the newest version.";
      }

      const added = (next.parts ?? []).filter(
        (part) => !(plugin.parts ?? []).includes(part),
      );

      return plugin.turnedOn && !next.turnedOn
        ? `Its newest version runs in more places${added.length > 0 ? `, its ${added.join(" and ")} part` : ""}, so it stays off until you turn it on again.`
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
        await request("plugins.remove", { params: { plugin: plugin.id } });

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
        await request("plugins.data.remove", { params: { plugin: plugin.id } });

        return undefined;
      });
    });
  };

  const meta = [
    installed ? "Installed" : "Built in",
    plugin.state === "off" && !switchesAtRestart(plugin) ? "Off" : undefined,
  ].filter((part) => part !== undefined);

  return (
    <li
      aria-label={plugin.title}
      className={cn(cardClass, "flex flex-col gap-2 p-4")}
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
        <PluginSwitch
          plugin={plugin}
          label="On"
          checked={plugin.turnedOn}
          onChange={turn}
        />
      </div>
      <p className="text-label text-fg-dim">{plugin.description}</p>
      <Links plugin={plugin} plugins={plugins} />
      {(plugin.provides ?? []).length > 0 && (
        <p className="text-label text-fg-dim">
          Provides {(plugin.provides ?? []).join(", ")}
        </p>
      )}
      {(plugin.uses ?? []).length > 0 && (
        <p className="text-caption text-fg-dim">
          Uses {(plugin.uses ?? []).join(", ")}
        </p>
      )}
      {installed && (
        <p className="break-all font-mono text-mono-sm text-fg-dim">
          {plugin.installedFrom === undefined
            ? "written in place"
            : `${plugin.installedFrom.url} at ${shortPin(plugin.installedFrom.pinned)}`}
        </p>
      )}
      <div className="mt-auto flex flex-wrap items-center gap-x-1.5 gap-y-1 text-caption text-fg-dim">
        <span>{meta.join(" · ")}</span>
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
      {asking}
    </li>
  );
}

function shortPin(pinned: string): string {
  return pinned.startsWith("sha256:")
    ? pinned.slice(0, "sha256:".length + 12)
    : pinned.slice(0, 12);
}

// The plugins it needs, those that need it, and those it works with
// (ADR 0077).
function Links({
  plugin,
  plugins,
}: {
  readonly plugin: PluginInfo;
  readonly plugins: readonly PluginInfo[];
}): ReactElement {
  const title = titleIn(plugins);

  const neededBy = plugins.filter(
    ({ turnedOn, requires = [] }) => turnedOn && requires.includes(plugin.id),
  );

  const lines = [
    ...((plugin.requires ?? []).length > 0
      ? [`Needs ${(plugin.requires ?? []).map(title).join(", ")}`]
      : []),
    ...(neededBy.length > 0
      ? [`Needed by ${neededBy.map(({ id }) => title(id)).join(", ")}`]
      : []),
    ...(plugin.worksWith ?? []).map(
      ({ plugin: other, through }) =>
        `Works with ${title(other)}: ${through
          .map((each) =>
            each === "events"
              ? "listens to its events"
              : "runs as its technical users",
          )
          .join(" and ")}`,
    ),
  ];

  return (
    <>
      {lines.map((line) => (
        <p key={line} className="text-label text-fg-dim">
          {line}
        </p>
      ))}
    </>
  );
}

function titleIn(plugins: readonly PluginInfo[]): (id: string) => string {
  return (id) => plugins.find((each) => each.id === id)?.title ?? id;
}

// Asks before turning a plugin on or off when others switch with it, and
// before turning an installed one on, since its code runs unsandboxed. A
// built-in one comes with the server.
export async function turnPlugin(
  plugin: PluginInfo,
  plugins: readonly PluginInfo[],
  ask: (options: ConfirmOptions) => Promise<boolean>,
): Promise<void> {
  const on = !plugin.turnedOn;
  const title = titleIn(plugins);

  const also = switchingWith(
    plugins,
    plugin.id,
    on,
    (id) => plugins.find((each) => each.id === id)?.turnedOn === true,
  );

  const installed = [plugin.id, ...also].flatMap((id) => {
    const found = plugins.find((each) => each.id === id);

    return on && found?.source === "installed" ? [found] : [];
  });

  if (
    (also.length > 0 || installed.length > 0) &&
    !(await ask(
      switchQuestion(
        plugin.title,
        [
          ...(also.length > 0
            ? [alsoSwitched(plugin.title, also.map(title), on)]
            : []),
          ...(installed.length > 0 ? [trustQuestion(plugin, installed)] : []),
        ],
        on,
      ),
    ))
  ) {
    return;
  }

  await request("plugins.update", {
    params: { plugin: plugin.id },
    body: { enabled: !plugin.turnedOn, digest: plugin.digest },
  });
}

// Turning off is the danger, since what needs the plugin goes off with it.
export function switchQuestion(
  what: string,
  reasons: readonly string[],
  on: boolean,
): ConfirmOptions {
  return {
    title: `Turn ${on ? "on" : "off"} ${what}?`,
    description: reasons.join(" "),
    confirm: on ? "Turn on" : "Turn off",
    danger: !on,
  };
}

// A switch that says why it can't move when the plugin's switches are set
// elsewhere.
export function PluginSwitch({
  plugin,
  label,
  checked,
  onChange,
}: {
  readonly plugin: PluginInfo;
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (on: boolean) => void;
}): ReactElement {
  return (
    <span title={plugin.switchLocked}>
      <Switch
        label={label}
        labelHidden
        checked={checked}
        disabled={plugin.switchLocked !== undefined}
        onChange={onChange}
      />
    </span>
  );
}

export function alsoSwitched(
  title: string,
  others: readonly string[],
  on: boolean,
): string {
  const named = others.join(", ");
  const one = others.length === 1;

  return on
    ? `It needs ${named}, so ${one ? "it turns" : "they turn"} on too.`
    : `${named} ${one ? "needs" : "need"} ${title}, so ${one ? "it turns" : "they turn"} off too. ${one ? "Its" : "Their"} data stays.`;
}

// What turning installed plugins on lets them do, since their code runs
// unsandboxed.
function trustQuestion(
  plugin: PluginInfo,
  installed: readonly PluginInfo[],
): string {
  const parts = installed.flatMap((each) => each.parts ?? []);
  const one = installed.length === 1;
  const its = one ? "Its" : "Their";

  return [
    ...(one && installed[0]?.id === plugin.id
      ? []
      : [
          `${installed.map(({ title }) => title).join(", ")} ${one ? "is" : "are"} installed.`,
        ]),
    `${its} code runs inside the Pipoca server, with the server's access.`,
    ...(parts.includes("web")
      ? [`${its} web part runs in the page of everyone who opens Pipoca.`]
      : []),
    ...(parts.includes("session")
      ? [
          `${its} Session part runs in every Session, on every machine that runs one, laptops included.`,
        ]
      : []),
    "Turn on only plugins you trust.",
  ].join(" ");
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
