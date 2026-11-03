import {
  availability,
  type Environment,
  type EnvironmentKind,
  type EnvironmentTemplate,
  kindOf,
} from "@pipoca/protocol";
import {
  Badge,
  Button,
  cn,
  fieldClass,
  Icon,
  KeyValues,
  PageTitle,
  Row,
  Rows,
  Section,
  Select,
  type KeyValue,
} from "@pipoca/ui";
import {
  type ReactElement,
  type ReactNode,
  type SubmitEvent,
  useRef,
  useState,
} from "react";
import { api, send } from "./api";
import { useTemplates } from "./hooks";
import { PluginBoundary } from "./plugin-boundary";
import { enabledPlugins, pluginContext } from "./plugins";
import { Templates } from "./templates";
import { settingsPageClass } from "./page-class";

const kindNames: Readonly<Record<EnvironmentKind, string>> = {
  machine: "Machines",
  docker: "Docker image",
  kubernetes: "Kubernetes",
};

const kindAbout: Readonly<Record<EnvironmentKind, string>> = {
  machine:
    "Sessions run on the machines that join it, with what's installed there.",
  docker:
    "One container from its image on a machine that joins it, shared by its Sessions.",
  kubernetes:
    "Each person gets a pod on the cluster, which their Sessions share. There are no machines to connect: the server starts a pod when a Session needs one and stops it when it goes idle.",
};

export function EnvironmentsPage({
  environments,
  selected,
  onChange,
}: {
  readonly environments: readonly Environment[];
  readonly selected: string;
  readonly onChange: () => void;
}): ReactElement {
  const environment = environments.find(({ id }) => id === selected);
  const templates = useTemplates();
  const [adding, setAdding] = useState(false);

  // A key shows once, right after it is made (ADR 0033).
  const [madeKey, setMadeKey] = useState<{
    readonly environmentId: string;
    readonly key: string;
  }>();

  if (environment) {
    return (
      <div id="environments-page" className={settingsPageClass}>
        <a
          href="#environments"
          className="mb-3 inline-flex items-center gap-1 text-label text-fg-dim hover:text-fg"
        >
          <Icon name="chevron-left" className="size-3.5" />
          Environments
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
      </div>
    );
  }

  return (
    <div id="environments-page" className={settingsPageClass}>
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0 flex-1">
          <PageTitle description="Where your Sessions run: a machine you connect, a Docker image on one, or pods on Kubernetes. Each has the tools and secrets its Sessions need, and it is yours alone.">
            Environments
          </PageTitle>
        </div>
        <Button
          className="mt-7 shrink-0"
          variant="primary"
          onClick={() => {
            setAdding(!adding);
          }}
        >
          <Icon name="plus" />
          New Environment
        </Button>
      </div>
      {adding && (
        <NewEnvironment
          templates={templates.value}
          onCreated={(environmentId, key) => {
            setMadeKey({ environmentId, key });
            setAdding(false);
            onChange();
            location.hash = `#environments/${environmentId}`;
          }}
        />
      )}
      <ul aria-label="Your Environments" className="mt-6 flex flex-col gap-2.5">
        {environments.length === 0 && (
          <li className="rounded-lg border border-dashed border-line-strong p-5 text-ui text-fg-dim">
            No Environment yet. Make one to connect a machine.
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
      <Templates templates={templates.value} onChange={templates.reload} />
    </div>
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
      href={`#environments/${environment.id}`}
      className="flex items-center gap-4 rounded-lg border border-line bg-elevated p-4 shadow-xs hover:border-line-strong"
    >
      <span
        aria-hidden="true"
        className="grid size-11 shrink-0 place-items-center rounded-md border border-line bg-hover"
      >
        <Icon
          name={kind === "machine" ? "monitor" : "cloud"}
          className="size-5"
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2 text-prose font-medium text-fg-strong">
          {environment.name}
          {kind !== "machine" && <Tag>{kindNames[kind]}</Tag>}
          {template !== undefined && <Tag>From a template</Tag>}
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

function Tag({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <span className="inline-flex h-5 items-center rounded-full bg-hover px-2 text-caption font-medium text-fg">
      {children}
    </span>
  );
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function NewEnvironment({
  templates,
  onCreated,
}: {
  readonly templates: readonly EnvironmentTemplate[];
  readonly onCreated: (environmentId: string, key: string) => void;
}): ReactElement {
  const [error, setError] = useState<string>();

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const template = fields.get("template");

    void api("/api/environments", {
      name: fields.get("name"),
      ...(typeof template === "string" && template !== "" && { template }),
    })
      .then(async (response) => {
        const created = (await response.json()) as {
          readonly environment: Environment;
          readonly key: string;
        };

        setError(undefined);
        form.reset();
        onCreated(created.environment.id, created.key);
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
      <input
        name="name"
        required
        aria-label="New Environment name"
        placeholder="laptops"
        className={cn(fieldClass, "w-48 font-mono")}
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
      {error !== undefined && (
        <p role="alert" className="text-caption text-failed">
          {error}
        </p>
      )}
    </form>
  );
}

function JoinKey({
  environment,
  madeKey,
  onKey,
}: {
  readonly environment: Environment;
  readonly madeKey: string | undefined;
  readonly onKey: (key: string) => void;
}): ReactElement {
  const [error, setError] = useState<string>();

  const replace = (): void => {
    if (
      environment.hasKey &&
      !confirm(
        "Agents that joined with the current key will have to join again with the new one.",
      )
    ) {
      return;
    }

    void api(`/api/environments/${environment.id}/key`, {})
      .then(async (response) => {
        onKey(((await response.json()) as { readonly key: string }).key);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  };

  return (
    <div className="mt-3 flex flex-col gap-2 text-ui">
      {madeKey === undefined ? (
        <p className="text-fg-dim">
          {environment.hasKey
            ? "Agents join with this Environment's key, which was shown when it was made."
            : "No agent can join until the Environment has a key."}
        </p>
      ) : (
        <>
          <p className="text-fg-dim">
            Start an agent with this key. It is shown only now.
          </p>
          <pre
            aria-label="Join command"
            className="overflow-x-auto rounded-md border border-line bg-elevated p-3 font-mono text-mono-sm"
          >
            {`PIPOCA_KEY=${madeKey} pipoca agent --server ${location.origin}`}
          </pre>
        </>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={replace}>
          {environment.hasKey ? "Replace key" : "Make key"}
        </Button>
        {error !== undefined && (
          <p role="alert" className="text-caption text-failed">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function Editor({
  environment,
  template,
  madeKey,
  onKey,
  onChange,
}: {
  readonly environment: Environment;
  readonly template: EnvironmentTemplate | undefined;
  readonly madeKey: string | undefined;
  readonly onKey: (key: string) => void;
  readonly onChange: () => void;
}): ReactElement {
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  // What the form's fields started from. Only fields edited since are sent,
  // so a save keeps changes made elsewhere meanwhile.
  const shown = useRef<Readonly<Record<string, string>>>(
    fieldsOf(environment, template),
  );

  const [rows, setRows] = useState(() => rowsOf(environment));
  const [isolation, setIsolation] = useState(environment.isolation);

  const update = (body: unknown, then?: () => void): void => {
    setSaved(false);

    send(`/api/environments/${environment.id}`, "PATCH", body).then(
      () => {
        setError(undefined);
        setSaved(true);
        then?.();
        onChange();
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);

    const text = (name: string): string => {
      const value = form.get(name);

      return typeof value === "string" ? value : "";
    };

    const fields = Object.fromEntries(
      Object.keys(shown.current).map((name) => [name, text(name)]),
    );

    const edited = (name: string): boolean =>
      fields[name] !== shown.current[name];

    try {
      const image = text("image").trim();
      const { variables, secrets } = changedValues(environment, rows);

      update(
        {
          ...(edited("name") && { name: text("name") }),
          ...(edited("isolation") && { isolation: text("isolation") }),
          ...(edited("image") && { image: image === "" ? null : image }),
          ...(edited("setupScript") && { setupScript: text("setupScript") }),
          ...(variables !== undefined && { variables }),
          secrets,
        },
        () => {
          shown.current = fields;

          setRows(
            rows.map((row) =>
              row.secret && row.value !== ""
                ? { ...row, value: "", saved: true }
                : row,
            ),
          );
        },
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const area = cn(fieldClass, "min-h-24 resize-y font-mono text-mono-sm");
  const kind = kindOf(environment);
  const status = availability(environment);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="text-display font-medium tracking-tight text-fg-strong">
          {environment.name}
        </h1>
        <Badge state={status === "Offline" ? "offline" : "done"}>
          {status === "Starts runners on demand" ? "Starts on demand" : status}
        </Badge>
      </div>
      <p className="mt-1 max-w-prose text-ui text-fg-dim">
        {kindAbout[kind]} Changes reach a Session the next time it starts.
      </p>
      {template !== undefined && (
        <Note icon="lock">
          Made from the admins&apos; template <strong>{template.name}</strong>.
          Its image, setup and isolation follow the template, and your own
          secrets stay yours.
        </Note>
      )}
      {kind === "kubernetes" ? (
        <Section title="Pods">
          <Rows label="Pods">
            {template !== undefined && (
              <Row title="Image" description="What every pod starts from">
                <span className="font-mono text-mono-sm text-fg">
                  {template.image ?? "Default image"}
                </span>
              </Row>
            )}
            <Row title="Running now">
              <span className="text-label text-fg-dim">
                {plural(
                  environment.runners.filter(({ online }) => online).length,
                  "pod",
                )}
              </span>
            </Row>
          </Rows>
        </Section>
      ) : (
        <Section title="Machines">
          <Rows label="Machines">
            {environment.runners.length === 0 && (
              <Row
                title={
                  environment.onDemand
                    ? "None is running"
                    : "No machine has joined yet"
                }
                description={
                  environment.onDemand
                    ? "One starts when a Session needs it."
                    : "Run the join command below on a machine to connect it."
                }
              />
            )}
            {environment.runners.map((runner) => (
              <Row
                key={runner.name}
                title={
                  <>
                    <span className="font-mono">{runner.name}</span>
                    <Badge state={runner.online ? "done" : "offline"}>
                      {runner.online ? "Online" : "Offline"}
                    </Badge>
                  </>
                }
              >
                <span className="text-label text-fg-dim">
                  {runner.capacity === null
                    ? `${String(runner.running)} running`
                    : `${String(runner.running)} of ${String(runner.capacity)} running`}
                </span>
              </Row>
            ))}
          </Rows>
          <JoinKey environment={environment} madeKey={madeKey} onKey={onKey} />
          {environment.folders.length > 0 && (
            <ul aria-label="Folders" className="mt-3 flex flex-wrap gap-1.5">
              {environment.folders.map((folder) => (
                <li
                  key={folder}
                  title={folder}
                  className="max-w-full truncate rounded-full border border-line bg-elevated px-2.5 py-1 font-mono text-mono-sm"
                >
                  {folder}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
      <form onSubmit={submit} className="flex flex-col">
        <Section title="Name">
          <input
            name="name"
            required
            aria-label="Name"
            defaultValue={environment.name}
            className={fieldClass}
          />
        </Section>
        {template === undefined && kind !== "kubernetes" && (
          <Section title="Each Session runs">
            <div className="grid gap-2.5 sm:grid-cols-2">
              {(
                [
                  [
                    "process",
                    "On the machine",
                    "With what's installed there. Fast, nothing to set up.",
                  ],
                  [
                    "container",
                    "In a container",
                    "One container from an image, shared by its Sessions. Needs Docker.",
                  ],
                ] as const
              ).map(([value, title, about]) => (
                <label
                  key={value}
                  className="flex cursor-pointer flex-col gap-1 rounded-lg border border-line bg-elevated p-4 has-checked:border-fg-strong has-checked:shadow-xs"
                >
                  <span className="flex items-center gap-2 text-ui font-medium text-fg-strong">
                    <input
                      type="radio"
                      name="isolation"
                      value={value}
                      checked={isolation === value}
                      onChange={() => {
                        setIsolation(value);
                      }}
                      className="accent-(--accent)"
                    />
                    {title}
                  </span>
                  <span className="text-label text-fg-dim">{about}</span>
                </label>
              ))}
            </div>
            {isolation === "process" && (
              <Note icon="terminal">
                Sessions here use what&apos;s already installed on the machine.
                A setup script and image show up when Sessions run in a
                container.
              </Note>
            )}
          </Section>
        )}
        {template === undefined && (
          <div
            hidden={kind !== "kubernetes" && isolation !== "container"}
            className="flex flex-col"
          >
            <Section title="Image">
              <input
                name="image"
                aria-label="Container image, empty for the default"
                defaultValue={environment.image ?? ""}
                placeholder="node:22-bookworm"
                className={cn(fieldClass, "font-mono")}
              />
            </Section>
            <Section
              title="Setup script"
              description="Runs once in each new container or pod before its first Session"
            >
              <textarea
                name="setupScript"
                aria-label="Setup script"
                rows={4}
                defaultValue={environment.setupScript}
                placeholder="apt-get install -y ripgrep"
                className={area}
              />
            </Section>
          </div>
        )}
        <Section title="Variables and secrets">
          <KeyValues
            label="Variables. A lock keeps one secret."
            rows={rows}
            onChange={setRows}
          />
          <Note icon="lock">
            Git and gh sign in to every host the Session&apos;s owner connected
            on their own, so no token variable is needed. Secrets are sealed on
            the server and only reach the machine when a Session starts.
          </Note>
        </Section>
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Button variant="primary" type="submit">
            Save
          </Button>
          <Button
            variant="danger"
            aria-label={`Delete ${environment.name}`}
            onClick={() => {
              deleteEnvironment(environment).then(
                (deleted) => {
                  if (deleted) {
                    location.hash = "#environments";
                    onChange();
                  }
                },
                (reason: unknown) => {
                  setError(
                    reason instanceof Error ? reason.message : String(reason),
                  );
                },
              );
            }}
          >
            Delete
          </Button>
          <p role="status" className="text-caption">
            {error !== undefined ? (
              <span className="text-failed">{error}</span>
            ) : (
              saved && <span className="text-fg-dim">Saved</span>
            )}
          </p>
        </div>
      </form>
      {enabledPlugins().map(
        ({ name, EnvironmentSection }) =>
          EnvironmentSection && (
            <PluginBoundary key={name} name={name}>
              <EnvironmentSection
                context={pluginContext(name)}
                environment={environment}
              />
            </PluginBoundary>
          ),
      )}
    </>
  );
}

function Note({
  icon,
  children,
}: {
  readonly icon: "lock" | "terminal";
  readonly children: ReactNode;
}): ReactElement {
  return (
    <p className="mt-3 flex gap-2.5 rounded-lg bg-hover p-3.5 text-label text-fg">
      <Icon name={icon} className="mt-0.5 size-4 shrink-0 text-fg-dim" />
      <span>{children}</span>
    </p>
  );
}

// Whether the person went ahead. The server refuses while any of its
// Sessions isn't archived.
export async function deleteEnvironment(
  environment: Environment,
): Promise<boolean> {
  if (
    !confirm(
      `Delete ${environment.name}? Its runners stop working, and its archived Sessions go with it.`,
    )
  ) {
    return false;
  }

  await send(`/api/environments/${environment.id}`, "DELETE");

  return true;
}

function rowsOf(environment: Environment): readonly KeyValue[] {
  return [
    ...Object.entries(environment.variables).map(([name, value]) => ({
      name,
      value,
      secret: false,
    })),
    ...environment.secrets.map((name) => ({
      name,
      value: "",
      secret: true,
      saved: true,
    })),
  ];
}

// The variables when they changed, and the secrets to set or, as null, to
// remove. A saved secret left empty keeps its value.
function changedValues(
  environment: Environment,
  rows: readonly KeyValue[],
): {
  readonly variables: Record<string, string> | undefined;
  readonly secrets: Record<string, string | null>;
} {
  const named = rows.filter(({ name }) => name.trim() !== "");
  const names = named.map(({ name }) => name.trim());
  const twice = names.find((name, index) => names.indexOf(name) !== index);

  if (twice !== undefined) {
    throw new Error(`${twice} is set twice.`);
  }

  const variables = Object.fromEntries(
    named
      .filter(({ secret }) => !secret)
      .map(({ name, value }) => [name.trim(), value]),
  );

  const secrets = {
    ...Object.fromEntries(
      environment.secrets
        .filter((name) => !named.some((row) => row.secret && row.name === name))
        .map((name) => [name, null]),
    ),
    ...Object.fromEntries(
      named
        .filter(({ secret, value }) => secret && value !== "")
        .map(({ name, value }) => [name.trim(), value]),
    ),
  };

  return {
    variables:
      JSON.stringify(variables) === JSON.stringify(environment.variables)
        ? undefined
        : variables,
    secrets,
  };
}

// A template sets the other fields, so the form has only the name then.
function fieldsOf(
  environment: Environment,
  template: EnvironmentTemplate | undefined,
): Record<string, string> {
  return {
    name: environment.name,
    ...(template === undefined && {
      ...(kindOf(environment) !== "kubernetes" && {
        isolation: environment.isolation,
      }),
      image: environment.image ?? "",
      setupScript: environment.setupScript,
    }),
  };
}
