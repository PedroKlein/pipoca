import { useApi, useLoaded } from "@pipoca/plugins/web";
import type { PrivateHosts } from "@pipoca/protocol";
import {
  Badge,
  Button,
  buttonClass,
  ErrorText,
  Switch,
  TextArea,
} from "@pipoca/ui";
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
          <CaRow host={host} locked={locked} />
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

// The private host's own CA, which the server trusts for that host only.
function CaRow({
  host,
  locked,
}: {
  readonly host: string;
  readonly locked: boolean;
}): ReactElement {
  const api = useApi(gitHosts);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();

  const listed = useLoaded(
    async () => api.get<PrivateHosts>("/api/settings/private-hosts"),
    "private-hosts",
    { topics: ["private-hosts"] },
  );

  const ca = listed.value?.hosts.find((each) => each.host === host)?.ca;

  const save = async (next: string | null): Promise<void> => {
    const { hosts } = await api.get<PrivateHosts>(
      "/api/settings/private-hosts",
    );

    await api.put("/api/settings/private-hosts", {
      hosts: hosts.map((each) =>
        each.host === host ? { ...each, ca: next } : each,
      ),
    });
  };

  const run = (next: string | null): void => {
    save(next).then(
      () => {
        setError(undefined);
        setEditing(false);
        listed.reload();
      },
      (failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
  };

  return (
    <NetworkRow
      title="Certificate authority"
      description={
        typeof ca === "string"
          ? "Its own CA is set, trusted for this host only, by Pipoca and by the git it runs."
          : "Your company's CA, trusted for this host only. Leave it empty if its certificate is public."
      }
    >
      {!locked && !editing && (
        <span className="flex gap-2">
          {typeof ca === "string" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                run(null);
              }}
            >
              Remove
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => {
              setDraft("");
              setEditing(true);
            }}
          >
            {typeof ca === "string" ? "Replace" : "Add CA certificate"}
          </Button>
        </span>
      )}
      {editing && (
        <form
          aria-label={`CA for ${host}`}
          className="flex w-full flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            run(draft.trim() === "" ? null : draft);
          }}
        >
          <TextArea
            rows={4}
            aria-label="CA certificate in PEM"
            className="font-mono text-caption"
            placeholder="-----BEGIN CERTIFICATE-----"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
          <ErrorText size="caption">{error}</ErrorText>
          <span className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
              }}
            >
              Cancel
            </Button>
            <Button size="sm" type="submit" variant="primary">
              Save
            </Button>
          </span>
        </form>
      )}
      {!editing && <ErrorText size="caption">{error}</ErrorText>}
    </NetworkRow>
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
