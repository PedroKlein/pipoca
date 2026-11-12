import { useApi } from "@pipoca/plugins/web";
import type { PrivateHosts } from "@pipoca/protocol";
import { Badge, buttonClass, ErrorText, Switch } from "@pipoca/ui";
import { type ReactElement, type ReactNode, useState } from "react";
import { gitHosts } from "../plugin";
import type { Reach } from "../src/model";

// Whether a private host can be reached now through one of the person's
// Environments, or the team's for team work (ADR 0080).
export function reachable(reach: Reach): boolean {
  return !reach.private || reach.through.some(({ online }) => online);
}

export function PrivateBadge({
  reach,
}: {
  readonly reach: Reach;
}): ReactElement | null {
  return reach.private ? <Badge>Private</Badge> : null;
}

// What a private host is reached through, for the host's row.
export function reachText(host: string, reach: Reach, team = false): string {
  const names = reach.through.map(({ name }) => name).join(" or ");

  if (reach.through.length === 0) {
    return team
      ? `No team Environment reaches ${host} yet, so the team's App can't poll for events or push. People's own work is unaffected.`
      : `Inside your company's network. Pipoca reaches it only through a machine of yours that can.`;
  }

  return reach.through.some(({ online }) => online)
    ? `Reached through ${names}`
    : `Reached through ${names}, which ${reach.through.length === 1 ? "is" : "are"} offline`;
}

// In place of signing in while no machine of the person's reaches the host.
export function NoRoute({
  host,
  team = false,
}: {
  readonly host: string;
  readonly team?: boolean;
}): ReactElement {
  return (
    <li className="flex flex-col gap-2 border-t border-line px-4 py-3 text-label">
      <span className="font-medium text-fg-strong">
        {team
          ? "No team Environment reaches it"
          : "No machine of yours reaches it"}
      </span>
      <span className="text-fg-dim">
        {team
          ? `Join a shared VM on that network as a team Environment, started with --reach ${host}.`
          : "Connect a VM or laptop on that network first. Then sign in here; the sign-in goes through it."}
      </span>
      <span className="flex flex-wrap items-center gap-3">
        <a
          className={buttonClass({ className: "no-underline" })}
          href={team ? "#team/setup/environments" : "#settings/environments"}
        >
          {team
            ? "Set up a team Environment"
            : "Connect a machine that reaches it"}
        </a>
        <span className="text-caption text-fg-dim">
          Already have one? Add{" "}
          <code className="font-mono">--reach {host}</code> when you start its
          runner, and it shows up here.
        </span>
      </span>
    </li>
  );
}

// A private host's network as server setup shows it: whether it's private,
// where its CA is set, and how team calls reach it.
export function NetworkRows({
  host,
  reach,
  locked,
  onChange,
}: {
  readonly host: string;
  readonly reach: Reach;
  readonly locked: boolean;
  readonly onChange: () => void;
}): ReactElement {
  return (
    <>
      <NetworkRow
        title="Private host"
        description={
          reach.private
            ? "The server can't reach it. Each person's calls go through their own Environment that reaches it, and team calls through a team Environment."
            : `Off. The server reaches ${host} directly.`
        }
      >
        {!locked && (
          <PrivateSwitch
            host={host}
            reach={reach}
            onChange={onChange}
            labelHidden
          />
        )}
      </NetworkRow>
      {reach.private && (
        <>
          <NetworkRow
            title="Certificate authority"
            description="Your company's CA, trusted for this host only. Leave it empty if its certificate is public."
          >
            <a
              className={buttonClass({ size: "sm", className: "no-underline" })}
              href="#settings/private-hosts"
            >
              Set in Private hosts
            </a>
          </NetworkRow>
          <NetworkRow
            title="Team calls"
            description={reachText(host, reach, true)}
          >
            {reach.through.length === 0 && (
              <a
                className={buttonClass({
                  size: "sm",
                  className: "no-underline",
                })}
                href="#team/setup/environments"
              >
                Set up a team Environment
              </a>
            )}
          </NetworkRow>
        </>
      )}
    </>
  );
}

function NetworkRow({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children?: ReactNode;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-line py-2.5">
      <span className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        <span className="text-ui font-medium text-fg-strong">{title}</span>
        <span className="text-label text-fg-dim">{description}</span>
      </span>
      {children}
    </div>
  );
}

// Marks a host private in the server's one list of private hosts, which
// other plugins use too.
export function PrivateSwitch({
  host,
  reach,
  onChange,
  labelHidden = false,
}: {
  readonly host: string;
  readonly reach: Reach;
  readonly onChange: () => void;
  readonly labelHidden?: boolean;
}): ReactElement {
  const api = useApi(gitHosts);
  const [error, setError] = useState<string>();

  const flip = async (on: boolean): Promise<void> => {
    const { hosts } = await api.get<PrivateHosts>(
      "/api/settings/private-hosts",
    );

    const others = hosts.filter((each) => each.host !== host);

    await api.put("/api/settings/private-hosts", {
      hosts: on ? [...others, { host, ca: null, teamWatch: false }] : others,
    });
  };

  return (
    <span className="flex items-center gap-2">
      <Switch
        label={labelHidden ? `${host} is private` : "Private"}
        labelHidden={labelHidden}
        checked={reach.private}
        onChange={(on) => {
          flip(on).then(
            () => {
              setError(undefined);
              onChange();
            },
            (failure: unknown) => {
              setError(
                failure instanceof Error ? failure.message : String(failure),
              );
            },
          );
        }}
      />
      <ErrorText size="caption">{error}</ErrorText>
    </span>
  );
}
