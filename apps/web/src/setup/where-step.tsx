import {
  Badge,
  Button,
  Chip,
  ChoiceCard,
  Command,
  ErrorText,
  Spinner,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { request } from "../data/client";
import { useAction, useQuery } from "../data/hooks";
import { connected } from "./step";

export function WhereStep(): ReactElement {
  const environments = useQuery("environments.list").data ?? [];
  const ready = environments.filter(connected);
  const [machine, setMachine] = useState(ready.length === 0);

  const add = useAction(async (name: string, template: string) =>
    request("environments.create", { body: { name, template } }),
  );

  const templates = useQuery("environmentTemplates.list").data ?? [];

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
                  <Chip key={folder} mono>
                    {folder}
                  </Chip>
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
            void add.run(template.name, template.id);
          }}
        />
      ))}
      <ErrorText size="caption">
        {add.error === undefined ? undefined : `Couldn't add it. ${add.error}`}
      </ErrorText>
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

  const make = useAction(async () => {
    setKey((await request("joinKeys.create")).key);
  });

  if (key === undefined) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => {
            void make.run();
          }}
        >
          Show the command
        </Button>
        <ErrorText size="caption">
          {make.error === undefined
            ? undefined
            : `Couldn't make a key. ${make.error}`}
        </ErrorText>
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
