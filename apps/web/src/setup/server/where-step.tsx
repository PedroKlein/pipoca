import type { ListedTemplate } from "@pipoca/protocol";
import {
  Badge,
  Button,
  ChoiceCard,
  Command,
  ErrorText,
  Field,
  TextInput,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { request } from "../../data/client";
import { useAction, useQuery } from "../../data/hooks";
import { pluginTitle } from "../../plugins";
import { useNewcomers } from "../../settings/people/newcomers";

const teamScope = { query: { scope: "team" } } as const;

// Where Sessions run on a team server (ADR 0072): the template each new
// person gets an Environment from, the team's own machines, and people's.
export function ServerWhereStep(): ReactElement {
  const templates = useQuery("environmentTemplates.list").data ?? [];
  const newcomers = useNewcomers();

  const pick = useAction(async (template: string | null) => {
    await request("settings.newcomers.update", {
      body: { ...newcomers, template },
    });
  });

  return (
    <div className="flex flex-col gap-2.5">
      <ul aria-label="Where Sessions run" className="flex flex-col gap-2.5">
        {templates.map((template) => (
          <ChoiceCard
            key={template.id}
            type="checkbox"
            as="li"
            title={
              template.runnersFrom?.choice ??
              template.runnersFrom?.label ??
              template.name
            }
            badge={
              template.runnersFrom !== null && (
                <Badge state="working">
                  From plugin: {pluginTitle(template.runnersFrom.plugin)}
                </Badge>
              )
            }
            description={
              template.runnersFrom === null
                ? "Each new person gets an Environment from this template."
                : "Each new person gets their own the first time they start a Session."
            }
            checked={newcomers.template === template.id}
            onChange={(checked) => {
              void pick.run(checked ? template.id : null);
            }}
          >
            <TemplateFields template={template} />
          </ChoiceCard>
        ))}
        <TeamMachines />
        <ChoiceCard
          type="checkbox"
          as="li"
          title="People's own machines"
          description="Anyone can connect their laptop in their own setup. Only they can use it."
          checked
          disabled
        />
      </ul>
      <ErrorText size="caption">{pick.error}</ErrorText>
    </div>
  );
}

// Saved when a field is left, as Settings saves a template.
function TemplateFields({
  template,
}: {
  readonly template: ListedTemplate;
}): ReactElement {
  const synced = template.source !== null;

  const save = useAction(async (change: Partial<ListedTemplate>) => {
    await request("environmentTemplates.update", {
      params: { id: template.id },
      body: change,
    });
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-3.5 sm:grid-cols-2">
        <Field label="Name people see">
          <TextInput
            defaultValue={template.name}
            disabled={synced}
            title={synced ? "It follows its repository" : undefined}
            onBlur={(event) => {
              const name = event.target.value.trim();

              if (name !== "" && name !== template.name) {
                void save.run({ name });
              }
            }}
          />
        </Field>
        <Field label="Image">
          <TextInput
            defaultValue={template.image ?? ""}
            placeholder="The default image"
            disabled={synced}
            title={synced ? "It follows its repository" : undefined}
            className="font-mono text-mono-sm"
            onBlur={(event) => {
              const image = event.target.value.trim();

              if (image !== (template.image ?? "")) {
                void save.run({ image: image === "" ? null : image });
              }
            }}
          />
        </Field>
      </div>
      <ErrorText size="caption">{save.error}</ErrorText>
    </div>
  );
}

// A VM or build box the whole team uses, as a team Environment (ADR 0064).
function TeamMachines(): ReactElement {
  const team = useQuery("environments.list", teamScope).data ?? [];
  const [key, setKey] = useState<string>();
  const [wanted, setWanted] = useState(false);
  const [first] = team;

  const make = useAction(async () => {
    const made =
      first === undefined
        ? await request("environments.create", {
            body: { name: "team-machines", team: true },
          })
        : await request("environments.keys.create", {
            params: { id: first.id },
          });

    setKey(made.key);
  });

  return (
    <ChoiceCard
      type="checkbox"
      as="li"
      title="Shared team machines"
      description="A VM or build box the whole team uses. You'll get a command to run on it."
      checked={first !== undefined || wanted}
      disabled={first !== undefined}
      onChange={setWanted}
    >
      {key === undefined ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => {
              void make.run();
            }}
          >
            Show the command
          </Button>
          <ErrorText size="caption">{make.error}</ErrorText>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-label text-fg-dim">
            Run it on the machine. The key is shown only now.
          </p>
          <Command label="Team join command">
            {`PIPOCA_KEY=${key} pipoca agent --server ${location.origin}`}
          </Command>
        </div>
      )}
    </ChoiceCard>
  );
}
