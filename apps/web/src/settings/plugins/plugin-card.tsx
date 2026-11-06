import type { PluginInfo } from "@pipoca/protocol";
import {
  Badge,
  Button,
  cardClass,
  cn,
  ErrorText,
  Switch,
  useConfirm,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { api } from "../../api";
import { webPartError } from "../../plugins";
import { switchesAtRestart } from "./restart";

export function PluginCard({
  plugin,
  onChange,
}: {
  readonly plugin: PluginInfo;
  readonly onChange: () => void;
}): ReactElement {
  const failure = webPartError(plugin.id);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const installed = plugin.source === "installed";
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
        await api("plugins.update", {
          params: { plugin: plugin.id },
          body: { enabled: !plugin.turnedOn, digest: plugin.digest },
        });

        return undefined;
      });
    });
  };

  const update = (): void => {
    run(async () => {
      const next = await api("plugins.update", {
        params: { plugin: plugin.id },
        body: { update: true },
      });

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
        await api("plugins.remove", { params: { plugin: plugin.id } });

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
        await api("plugins.data.remove", { params: { plugin: plugin.id } });

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
