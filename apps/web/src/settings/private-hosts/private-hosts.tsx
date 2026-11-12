import type { Environment, PrivateHost } from "@pipoca/protocol";
import {
  Badge,
  Button,
  ErrorText,
  Field,
  Icon,
  Notice,
  Page,
  plural,
  Row,
  Rows,
  Switch,
  TextArea,
  TextInput,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { request } from "../../data/client";
import { useAction, useQuery } from "../../data/hooks";

const fresh: PrivateHost = { host: "", ca: null, teamWatch: false };

// The hosts the server reaches only through Environments (ADR 0080), with
// who has a route to each.
export function PrivateHostsPage(): ReactElement {
  const hosts = useQuery("settings.privateHosts").data?.hosts ?? [];

  const environments =
    useQuery("environments.list", { query: { scope: "all" } }).data ?? [];

  const [editing, setEditing] = useState<number | "new">();

  const save = useAction(async (next: readonly PrivateHost[]) => {
    await request("settings.privateHosts.update", {
      body: { hosts: [...next] },
    });

    setEditing(undefined);
  });

  const form = (index: number | "new"): ReactElement => (
    <HostForm
      key={String(index)}
      saved={index === "new" ? fresh : (hosts[index] ?? fresh)}
      error={save.error}
      onCancel={() => {
        save.clear();
        setEditing(undefined);
      }}
      onSave={(host) => {
        void save.run(
          index === "new"
            ? [...hosts, host]
            : hosts.map((each, at) => (at === index ? host : each)),
        );
      }}
      {...(index !== "new" && {
        onRemove: () => {
          void save.run(hosts.filter((_, at) => at !== index));
        },
      })}
    />
  );

  return (
    <Page
      title="Private hosts"
      description="Hosts the server can't reach directly, such as ones inside your company network. Pipoca reaches them through an Environment that can: a person's own for their calls, a team Environment for the team's."
      actions={
        <Button
          variant="primary"
          onClick={() => {
            setEditing("new");
          }}
        >
          <Icon name="plus" />
          Add a private host
        </Button>
      }
    >
      {editing === "new" && form("new")}
      {hosts.length > 0 && (
        <Rows label="Private hosts">
          {hosts.map((host, index) =>
            editing === index ? (
              <li
                key={host.host}
                className="border-t border-line first:border-t-0"
              >
                {form(index)}
              </li>
            ) : (
              <HostRow
                key={host.host}
                host={host}
                environments={environments}
                onEdit={() => {
                  setEditing(index);
                }}
              />
            ),
          )}
        </Rows>
      )}
      {hosts.length === 0 && editing === undefined && (
        <p className="text-label text-fg-dim">
          No private hosts. Add one when a host sits inside your company
          network.
        </p>
      )}
      <Notice className="mt-6">
        The counts are how many people have an Environment that reaches each
        host. You see names and status only, never their calls. Every tunnel is
        logged with its owner, plugin, host, machine, bytes and duration.
      </Notice>
    </Page>
  );
}

function HostRow({
  host,
  environments,
  onEdit,
}: {
  readonly host: PrivateHost;
  readonly environments: readonly Environment[];
  readonly onEdit: () => void;
}): ReactElement {
  const reaching = environments.filter((environment) =>
    reachesHost(environment, host.host),
  );

  const people = new Set(
    reaching.flatMap(({ ownerId }) => (ownerId === "team" ? [] : [ownerId])),
  ).size;

  return (
    <Row
      title={<span className="font-mono">{host.host}</span>}
      description={
        host.ca === null
          ? "Public certificate"
          : "Its own CA, trusted for this host only"
      }
    >
      <span className="text-label text-fg-dim">
        {`${plural(people, "person", "people")} ${people === 1 ? "reaches" : "reach"} it`}
      </span>
      <TeamBadge host={host.host} environments={environments} />
      <Button variant="ghost" aria-label={`Edit ${host.host}`} onClick={onEdit}>
        Edit
      </Button>
    </Row>
  );
}

// How team work reaches the host: through which team Environment, or why not.
function TeamBadge({
  host,
  environments,
}: {
  readonly host: string;
  readonly environments: readonly Environment[];
}): ReactElement {
  const [name] = host.split(":");

  const named = environments.filter(
    ({ ownerId, reaches }) =>
      ownerId === "team" && reaches.some((each) => each.host === name),
  );

  const reaching = named.filter((each) => reachesHost(each, host));
  const online = reaching.filter((each) => each.online);

  if (named.length === 0) {
    return <Badge state="waiting">Team: no Environment</Badge>;
  }

  const names = (list: readonly Environment[]): string =>
    list.map(({ name: each }) => each).join(", ");

  if (reaching.length === 0) {
    return (
      <Badge state="failed">{`Team: ${names(named)} can't reach it`}</Badge>
    );
  }

  return online.length > 0 ? (
    <Badge state="done">{`Team: ${names(online)}, online`}</Badge>
  ) : (
    <Badge state="offline">{`Team: ${names(reaching)}, offline`}</Badge>
  );
}

// Whether a runner of the Environment reached the host, on any port.
export function reachesHost(environment: Environment, host: string): boolean {
  const [name] = host.split(":");

  return environment.reaches.some((each) => each.reached && each.host === name);
}

function HostForm({
  saved,
  error,
  onSave,
  onCancel,
  onRemove,
}: {
  readonly saved: PrivateHost;
  readonly error: string | undefined;
  readonly onSave: (host: PrivateHost) => void;
  readonly onCancel: () => void;
  readonly onRemove?: () => void;
}): ReactElement {
  const [draft, setDraft] = useState(saved);

  return (
    <form
      aria-label={
        saved.host === "" ? "Add a private host" : `Edit ${saved.host}`
      }
      className="mb-4 flex flex-col gap-4 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ ...draft, host: draft.host.trim().toLowerCase() });
      }}
    >
      <Field
        label="Host"
        hint="An exact name, with :port when it isn't 443. https only."
      >
        <TextInput
          value={draft.host}
          placeholder="github.acme.internal"
          onChange={(event) => {
            setDraft({ ...draft, host: event.target.value });
          }}
        />
      </Field>
      <Field
        label="Certificate authority"
        hint="Your company's CA in PEM, trusted for this host only, by Pipoca and by git it runs. Leave empty if its certificate is public."
      >
        <TextArea
          rows={4}
          className="font-mono text-caption"
          value={draft.ca ?? ""}
          placeholder="-----BEGIN CERTIFICATE-----"
          onChange={(event) => {
            const ca = event.target.value.trim();

            setDraft({ ...draft, ca: ca === "" ? null : event.target.value });
          }}
        />
      </Field>
      <div className="flex items-center gap-3">
        <span className="flex flex-1 flex-col gap-0.5">
          <span className="text-label font-medium text-fg">
            Team routines may watch it
          </span>
          <span className="text-caption text-fg-dim">
            Every user can start team routines, so this is off unless you allow
            it.
          </span>
        </span>
        <Switch
          label="Team routines may watch it"
          labelHidden
          checked={draft.teamWatch}
          onChange={(teamWatch) => {
            setDraft({ ...draft, teamWatch });
          }}
        />
      </div>
      <ErrorText size="caption">{error}</ErrorText>
      <div className="flex gap-2">
        {onRemove && (
          <Button variant="ghost" onClick={onRemove}>
            Remove
          </Button>
        )}
        <span className="flex-1" />
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary">
          Save
        </Button>
      </div>
    </form>
  );
}
