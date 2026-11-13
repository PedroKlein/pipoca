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
import { ReachChecklist, useReachFlags } from "../settings/environments/reach";
import { useNewcomers } from "../settings/people/newcomers";
import { StepFooter } from "./footer";
import { connected } from "./step";

// Each person's own places for Pi to work. The template the team picked
// for new people comes preselected, and Continue makes its Environment
// (ADR 0072).
export function WhereStep(): ReactElement {
  const environments = useQuery("environments.list").data ?? [];
  const ready = environments.filter(connected);
  const [machine, setMachine] = useState(ready.length === 0);
  const [keep, setKeep] = useState(true);
  const picked = useNewcomers().template;

  // A template's id is a slug, which fits an Environment's name; its name
  // may have spaces.
  const add = useAction(async (template: string) =>
    request("environments.create", { body: { name: template, template } }),
  );

  const templates = useQuery("environmentTemplates.list").data ?? [];

  const unused = templates.filter(
    (template) =>
      !environments.some(({ templateId }) => templateId === template.id),
  );

  const offered = unused.find(({ id }) => id === picked);

  // Templates a plugin starts runners for, which the person has no
  // Environment from yet.
  const started = unused.flatMap((template) =>
    template.runnersFrom === null || template === offered
      ? []
      : [{ ...template, runnersFrom: template.runnersFrom }],
  );

  return (
    <>
      <ul className="flex flex-col gap-2.5">
        {offered !== undefined && (
          <ChoiceCard
            type="checkbox"
            as="li"
            title={offered.runnersFrom?.label ?? offered.name}
            badge={<Badge>Picked by your team</Badge>}
            description="Your own Environment from the team's template, made when you continue."
            checked={keep}
            onChange={setKeep}
          />
        )}
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
            <ReachChecklist environment={environment} />
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
              void add.run(template.id);
            }}
          />
        ))}
        <ErrorText size="caption">
          {add.error === undefined
            ? undefined
            : `Couldn't add it. ${add.error}`}
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
      <StepFooter
        answer={
          offered !== undefined && keep
            ? async () => {
                await request("environments.create", {
                  body: { name: offered.id, template: offered.id },
                });
              }
            : undefined
        }
      />
    </>
  );
}

function ConnectMachine(): ReactElement {
  const [reach, reachPicker] = useReachFlags();
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

  const command = `PIPOCA_KEY=${key} pipoca agent --server ${location.origin}${reach}`;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-label text-fg-dim">
        Run it in the folder Pi should work in. The key is shown only now.
      </p>
      {reachPicker}
      <Command label="Join command">{command}</Command>
      <p aria-live="polite">
        <Spinner label="Waiting for the machine to connect…" />
      </p>
    </div>
  );
}
