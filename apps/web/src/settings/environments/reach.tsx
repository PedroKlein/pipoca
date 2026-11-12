import { type Environment, hostPortText, type Relayed } from "@pipoca/protocol";
import { Badge, Checkbox, Notice, Row, Rows, Section } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { useQuery } from "../../data/hooks";
import { pluginTitle } from "../../plugins";

// The private hosts an Environment's runners reach, and the tunnels the
// server opened through them (ADR 0080).
export function ReachSections({
  environment,
}: {
  readonly environment: Environment;
}): ReactElement | null {
  const relays = useQuery("environments.relays", {
    params: { id: environment.id },
  }).data;

  if (environment.reaches.length === 0) {
    return null;
  }

  const team = environment.ownerId === "team";

  const confirmed = (host: string, port: number): boolean =>
    relays?.confirmed.some(
      (each) => each.host === host && each.port === port,
    ) === true;

  return (
    <>
      <Section
        title="Private hosts it reaches"
        description={
          <>
            Named on the machine with <code className="font-mono">--reach</code>
            . Pipoca can&apos;t add to it.
          </>
        }
      >
        <Rows label="Private hosts it reaches">
          {environment.reaches.map(({ host, port, reached }) => (
            <Row
              key={hostPortText({ host, port })}
              title={
                <span className="font-mono">
                  {hostPortText({ host, port })}
                </span>
              }
              description={reachDescription(reached, confirmed(host, port))}
            >
              <Badge state={reached ? "done" : "failed"}>
                {reached ? "Reached" : "Not reached"}
              </Badge>
            </Row>
          ))}
        </Rows>
        <p className="mt-2 text-caption text-fg-dim">
          To change the list, restart the runner with other{" "}
          <code className="font-mono">--reach</code> hosts. A host that
          isn&apos;t on the server&apos;s private list is ignored.
        </p>
      </Section>
      <Section
        title="Recent relays"
        description={
          team
            ? "Team calls only. People's own calls never go through a team Environment."
            : `Pipoca's calls for you that went through ${environment.name}`
        }
      >
        <Rows label="Recent relays">
          {(relays?.recent.length ?? 0) === 0 && (
            <Row
              title="None yet"
              description="Calls show here as Pipoca makes them."
            />
          )}
          {relays?.recent.map((each) => (
            <RelayRow key={`${String(each.at)}${each.host}`} relayed={each} />
          ))}
        </Rows>
      </Section>
      <Section title="What this machine sees">
        <Notice icon="lock">
          {environment.name} passes encrypted traffic only. It sees which host
          each relay goes to, when, and how much, but never the content or the
          tokens. Revoking its runners or deleting the Environment closes its
          relays at once.
          {team &&
            ` While it's offline, team calls to these hosts pause, and team routines that need them say so. People's own work keeps going through their own machines.`}
        </Notice>
      </Section>
    </>
  );
}

function RelayRow({ relayed }: { readonly relayed: Relayed }): ReactElement {
  const time = new Date(relayed.at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  return (
    <Row
      leading={
        <span className="w-12 font-mono text-label text-fg-dim">{time}</span>
      }
      title={pluginTitle(relayed.plugin)}
      description={
        <>
          <span className="font-mono">{relayed.host}</span>
          {relayed.owner === "team" ? " · for the team" : ""}
        </>
      }
    >
      <span className="w-16 text-right text-label text-fg-dim">
        {sizeOf(relayed.bytes)}
      </span>
      <span className="w-14 text-right text-label text-fg-dim">
        {`${(relayed.ms / 1000).toFixed(1)} s`}
      </span>
    </Row>
  );
}

function sizeOf(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }

  return bytes < 1024 * 1024
    ? `${String(Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Which listed private hosts a machine about to join relays to, as the
// --reach flags of its command. Nothing shows while none is listed.
export function useReachFlags(): readonly [string, ReactElement | null] {
  const hosts = useQuery("settings.privateHosts").data?.hosts ?? [];
  const [picked, setPicked] = useState<readonly string[]>([]);

  const flags = picked
    .filter((host) => hosts.some((each) => each.host === host))
    .map((host) => ` --reach ${host}`)
    .join("");

  if (hosts.length === 0) {
    return [flags, null];
  }

  return [
    flags,
    <fieldset key="reach" className="flex flex-col gap-1.5">
      <legend className="mb-1 text-label font-medium text-fg">
        Private hosts this machine reaches
      </legend>
      {hosts.map(({ host }) => (
        <Checkbox
          key={host}
          label={host}
          checked={picked.includes(host)}
          onChange={() => {
            setPicked(
              picked.includes(host)
                ? picked.filter((each) => each !== host)
                : [...picked, host],
            );
          }}
        />
      ))}
      <span className="text-caption text-fg-dim">
        <code className="font-mono">--reach</code> is your consent: the machine
        relays only to the hosts named here, and Pipoca can&apos;t add more.
      </span>
    </fieldset>,
  ];
}

function reachDescription(reached: boolean, confirmed: boolean): string {
  if (!reached) {
    return "Named on the machine, but it didn't answer";
  }

  return confirmed
    ? "Confirmed by Pipoca with its own TLS check"
    : "Reached from the machine. Pipoca checks it on first use.";
}
