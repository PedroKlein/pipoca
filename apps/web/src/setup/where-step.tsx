import {
  Badge,
  Button,
  ChoiceCard,
  Command,
  ErrorText,
  Spinner,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { api } from "../api";
import { useEnvironments, useTemplates } from "../hooks";
import { connected } from "./step";

export function WhereStep(): ReactElement {
  const environments = useEnvironments().value;
  const ready = environments.filter(connected);
  const [machine, setMachine] = useState(ready.length === 0);
  const [error, setError] = useState<string>();

  const templates = useTemplates().value;

  // Templates a plugin starts runners for, which the person has no
  // Environment from yet.
  const started = templates.flatMap((template) =>
    template.runnersFrom === null ||
    environments.some(({ templateId }) => templateId === template.id)
      ? []
      : [{ ...template, runnersFrom: template.runnersFrom }],
  );

  return (
    <ul className="flex flex-col gap-2.5">
      {ready.map((environment) => (
        <ChoiceCard
          type="checkbox"
          as="li"
          key={environment.id}
          title={environment.name}
          badge={<Badge state="done">Ready</Badge>}
          description={
            environment.onDemand
              ? "Runners start when a Session needs one."
              : "Sessions work in folders on this machine, with its own tools and git setup."
          }
          checked
        >
          {environment.folders.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-label font-medium text-fg">
                Pi may work in any folder inside
              </span>
              <span className="flex flex-wrap gap-1.5">
                {environment.folders.map((folder) => (
                  <span
                    key={folder}
                    className="inline-flex h-7 items-center rounded-full border border-line px-2.5 font-mono text-mono-sm text-fg"
                  >
                    {folder}
                  </span>
                ))}
              </span>
            </div>
          )}
        </ChoiceCard>
      ))}
      {started.map((template) => (
        <ChoiceCard
          type="checkbox"
          as="li"
          key={template.id}
          title={template.runnersFrom.label}
          badge={<Badge state="offline">{template.name}</Badge>}
          description="Runners start when a Session needs one."
          checked={false}
          onChange={() => {
            api("environments.create", {
              body: { name: template.name, template: template.id },
            }).catch((reason: unknown) => {
              setError(`Couldn't add it. ${String(reason)}`);
            });
          }}
        />
      ))}
      <ErrorText size="caption">{error}</ErrorText>
      <ChoiceCard
        type="checkbox"
        as="li"
        title="Another machine"
        description="A Linux VM, a workstation or a second laptop. Run one command on it."
        checked={machine}
        onChange={setMachine}
      >
        <ConnectMachine />
      </ChoiceCard>
    </ul>
  );
}

function ConnectMachine(): ReactElement {
  const [key, setKey] = useState<string>();
  const [error, setError] = useState<string>();

  if (key === undefined) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => {
            api("joinKeys.create")
              .then(({ key: made }) => {
                setKey(made);
              })
              .catch((reason: unknown) => {
                setError(`Couldn't make a key. ${String(reason)}`);
              });
          }}
        >
          Show the command
        </Button>
        <ErrorText size="caption">{error}</ErrorText>
      </div>
    );
  }

  const command = `PIPOCA_KEY=${key} pipoca agent --server ${location.origin}`;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-label text-fg-dim">
        Run it in the folder Pi should work in. The key is shown only now.
      </p>
      <Command label="Join command">{command}</Command>
      <p aria-live="polite">
        <Spinner label="Waiting for the machine to connect…" />
      </p>
    </div>
  );
}
