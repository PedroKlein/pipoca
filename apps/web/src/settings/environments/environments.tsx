import {
  availability,
  type Environment,
  type EnvironmentTemplate,
  kindOf,
} from "@pipoca/protocol";
import {
  Avatar,
  Badge,
  Button,
  cn,
  EmptyState,
  ErrorText,
  Icon,
  linkCardClass,
  Page,
  plural,
  Select,
  TextInput,
} from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { api } from "../../api";
import { useTemplates } from "../../hooks";
import { Templates } from "./templates";
import { environmentsPath, kindNames } from "./kinds";
import { Editor } from "./editor";

// A person's Environments in Settings, or with team the team's in Team
// setup.
export function EnvironmentsPage({
  environments,
  team = false,
  selected,
  onChange,
}: {
  readonly environments: readonly Environment[];
  readonly team?: boolean;
  readonly selected: string;
  readonly onChange: () => void;
}): ReactElement {
  const environment = environments.find(({ id }) => id === selected);
  const root = environmentsPath(team);
  const templates = useTemplates();
  const [adding, setAdding] = useState(false);

  // A key shows once, right after it is made (ADR 0033).
  const [madeKey, setMadeKey] = useState<{
    readonly environmentId: string;
    readonly key: string;
  }>();

  if (environment) {
    return (
      <Page id="environments-page">
        <a
          href={`#${root}`}
          className="mb-3 inline-flex items-center gap-1 text-label text-fg-dim hover:text-fg"
        >
          <Icon name="chevron-left" className="size-3.5" />
          {team ? "Team Environments" : "Environments"}
        </a>
        <Editor
          key={environment.id}
          environment={environment}
          template={templates.value.find(
            ({ id }) => id === environment.templateId,
          )}
          madeKey={
            madeKey?.environmentId === environment.id ? madeKey.key : undefined
          }
          onKey={(key) => {
            setMadeKey({ environmentId: environment.id, key });
            onChange();
          }}
          onChange={onChange}
        />
      </Page>
    );
  }

  return (
    <Page
      id="environments-page"
      title={team ? "Team Environments" : "Environments"}
      description={
        team
          ? "Where team work runs. Everyone can start team work on these, and only admins change them. Their secrets reach the runner of every team Session."
          : "Where your Sessions run: a machine you connect, a Docker image on one, or pods on Kubernetes. Each has the tools and secrets its Sessions need, and it is yours alone."
      }
      actions={
        <Button
          variant="primary"
          onClick={() => {
            setAdding(!adding);
          }}
        >
          <Icon name="plus" />
          New Environment
        </Button>
      }
    >
      {adding && (
        <NewEnvironment
          templates={templates.value}
          team={team}
          onCreated={(environmentId, key) => {
            setMadeKey({ environmentId, key });
            setAdding(false);
            onChange();
            location.hash = `#${root}/${environmentId}`;
          }}
        />
      )}
      <ul
        aria-label={team ? "Team Environments" : "Your Environments"}
        className="mt-6 flex flex-col gap-2.5"
      >
        {environments.length === 0 && (
          <li>
            <EmptyState>
              {team
                ? "No team Environment yet. Team work can't start until there is one."
                : "No Environment yet. Make one to connect a machine."}
            </EmptyState>
          </li>
        )}
        {environments.map((each) => (
          <li key={each.id}>
            <EnvironmentCard
              environment={each}
              template={templates.value.find(
                ({ id }) => id === each.templateId,
              )}
            />
          </li>
        ))}
      </ul>
      {!team && (
        <Templates templates={templates.value} onChange={templates.reload} />
      )}
    </Page>
  );
}

function EnvironmentCard({
  environment,
  template,
}: {
  readonly environment: Environment;
  readonly template: EnvironmentTemplate | undefined;
}): ReactElement {
  const kind = kindOf(environment);
  const status = availability(environment);

  const running = environment.runners.reduce(
    (total, { running: count }) => total + count,
    0,
  );

  const image = environment.image ?? template?.image ?? "the default image";

  const summary = {
    machine:
      environment.folders.length > 0
        ? `Folders ${environment.folders.join(", ")}`
        : `${plural(environment.runners.length, "machine")} joined`,
    docker: `${image} · one container, Sessions share it`,
    kubernetes: `${image} · a pod per person, their Sessions share it`,
  }[kind];

  return (
    <a
      href={`#${environmentsPath(environment.ownerId === "team")}/${environment.id}`}
      className={cn(linkCardClass, "flex items-center gap-4 p-4")}
    >
      <Avatar name={environment.name} square size="lg">
        <Icon
          name={kind === "machine" ? "monitor" : "cloud"}
          className="size-5"
        />
      </Avatar>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2 text-prose font-medium text-fg-strong">
          {environment.name}
          {kind !== "machine" && <Badge>{kindNames[kind]}</Badge>}
          {template !== undefined && <Badge>From a template</Badge>}
        </span>
        <span className="truncate text-label text-fg-dim">{summary}</span>
      </span>
      <Badge state={status === "Offline" ? "offline" : "done"}>
        {status === "Starts runners on demand" ? "Starts on demand" : status}
      </Badge>
      <span className="hidden w-32 text-right text-label text-fg-dim sm:block">
        {running === 0 ? "Idle" : `${plural(running, "Session")} running`}
      </span>
      <Icon name="chevron-right" className="size-4 text-fg-dim" />
    </a>
  );
}

function NewEnvironment({
  templates,
  team,
  onCreated,
}: {
  readonly templates: readonly EnvironmentTemplate[];
  readonly team: boolean;
  readonly onCreated: (environmentId: string, key: string) => void;
}): ReactElement {
  const [error, setError] = useState<string>();

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const template = fields.get("template");
    const name = fields.get("name");

    void api("environments.create", {
      body: {
        name: typeof name === "string" ? name : "",
        ...(typeof template === "string" && template !== "" && { template }),
        ...(team && { team: true }),
      },
    })
      .then((created) => {
        setError(undefined);
        form.reset();
        onCreated(created.id, created.key);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  };

  return (
    <form
      onSubmit={submit}
      aria-label="New Environment"
      className="mt-4 flex flex-wrap items-center gap-2"
    >
      <TextInput
        name="name"
        required
        aria-label="New Environment name"
        placeholder="laptops"
        className="w-48 font-mono"
      />
      {templates.length > 0 && (
        <Select name="template" aria-label="Template" defaultValue="">
          <option value="">Machines I join</option>
          {templates.map(({ id, name }) => (
            <option key={id} value={id}>
              From {name}
            </option>
          ))}
        </Select>
      )}
      <Button type="submit">Create</Button>
      <ErrorText size="caption">{error}</ErrorText>
    </form>
  );
}
