import {
  availability,
  type Environment,
  type EnvironmentTemplate,
  type EnvironmentUpdate,
} from "@pipoca/protocol";
import {
  Badge,
  Button,
  ChoiceTiles,
  cn,
  Icon,
  KeyValues,
  Row,
  Rows,
  Section,
  TextArea,
  TextInput,
  useConfirm,
} from "@pipoca/ui";
import {
  type ReactElement,
  type ReactNode,
  type SubmitEvent,
  useRef,
  useState,
} from "react";
import { api } from "../../api";
import { PluginBoundary } from "../../plugin-boundary";
import { enabledPlugins, pluginContext } from "../../plugins";
import { environmentsPath, kindAbout } from "./kinds";
import { JoinKey } from "./join-key";
import { deleteEnvironment, rowsOf, changedValues, fieldsOf } from "./values";

export function Editor({
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
  const [ask, asking] = useConfirm();

  // What the form's fields started from. Only fields edited since are sent,
  // so a save keeps changes made elsewhere meanwhile.
  const shown = useRef<Readonly<Record<string, string>>>(
    fieldsOf(environment, template),
  );

  const [rows, setRows] = useState(() => rowsOf(environment));
  const [isolation, setIsolation] = useState(environment.isolation);

  const update = (body: EnvironmentUpdate, then?: () => void): void => {
    setSaved(false);

    api("environments.update", { params: { id: environment.id }, body }).then(
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
          ...(edited("isolation") && {
            isolation:
              text("isolation") === "container" ? "container" : "process",
          }),
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

  const area = "min-h-24 resize-y font-mono text-mono-sm";
  const status = availability(environment);
  const machines = environment.runnersFrom === null ? "Machines" : "Runners";

  return (
    <>
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="text-display font-medium text-fg-strong">
          {environment.name}
        </h1>
        <Badge state={status === "Offline" ? "offline" : "done"}>
          {status === "Starts runners on demand" ? "Starts on demand" : status}
        </Badge>
      </div>
      <p className="mt-1 max-w-prose text-ui text-fg-dim">
        {kindAbout(environment)} Changes reach a Session the next time it starts.
      </p>
      {template !== undefined && (
        <Note icon="lock">
          Made from the admins&apos; template <strong>{template.name}</strong>.
          Its image, setup and isolation follow the template, and your own
          secrets stay yours.
        </Note>
      )}
      <Section title={machines}>
          <Rows label={machines}>
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
          {environment.runnersFrom === null && (
            <JoinKey
              environment={environment}
              madeKey={madeKey}
              onKey={onKey}
            />
          )}
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
      <form onSubmit={submit} className="flex flex-col">
        <Section title="Name">
          <TextInput
            name="name"
            required
            aria-label="Name"
            defaultValue={environment.name}
          />
        </Section>
        {template === undefined && (
          <Section title="Each Session runs">
            <ChoiceTiles
              label="Each Session runs"
              name="isolation"
              value={isolation}
              onChange={setIsolation}
              tiles={[
                {
                  value: "process",
                  title: "On the machine",
                  description:
                    "With what's installed there. Fast, nothing to set up.",
                },
                {
                  value: "container",
                  title: "In a container",
                  description:
                    "One container from an image, shared by its Sessions. Needs Docker.",
                },
              ]}
            />
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
            hidden={isolation !== "container"}
            className="flex flex-col"
          >
            <Section title="Image">
              <TextInput
                name="image"
                aria-label="Container image, empty for the default"
                defaultValue={environment.image ?? ""}
                placeholder="node:22-bookworm"
                className="font-mono"
              />
            </Section>
            <Section
              title="Setup script"
              description="Runs once in each new container or pod before its first Session"
            >
              <TextArea
                name="setupScript"
                aria-label="Setup script"
                rows={4}
                defaultValue={environment.setupScript}
                placeholder="apt-get install -y ripgrep"
                className={cn(area)}
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
              deleteEnvironment(environment, ask).then(
                (deleted) => {
                  if (deleted) {
                    location.hash = `#${environmentsPath(environment.ownerId === "team")}`;
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
      {asking}
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
