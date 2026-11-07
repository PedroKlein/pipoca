import { useApi, useLoaded } from "@pipoca/plugins/web";
import {
  Badge,
  Button,
  cardClass,
  Checkbox,
  cn,
  ErrorText,
  Field,
  Icon,
  initialsOf,
  Row,
  Rows,
  Section,
  Step,
  Stepper,
  type StepState,
  TextInput,
  useConfirm,
} from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { gitHosts } from "../plugin";
import type { HostInput, HostView } from "../src/model";
import { signIn } from "./account";

// The hosts people can connect, each with its OAuth app, which admins add,
// change and remove. Settings shows it, and so can a setup step.
export function HostsEditor({
  onChange,
}: {
  readonly onChange?: () => void;
}): ReactElement {
  const api = useApi(gitHosts);
  const [ask, asking] = useConfirm();

  const { value, reload } = useLoaded(
    async () => api.get<readonly HostView[]>("hosts"),
    "hosts",
    { changes: ["hosts"] },
  );

  const [adding, onAdding] = useState(false);
  const [editing, setEditing] = useState<HostView>();
  const [settingUp, setSettingUp] = useState<string>();
  const [error, setError] = useState<string>();

  const changed = (): void => {
    setEditing(undefined);
    onAdding(false);
    reload();
    onChange?.();
  };

  const save = async (path: string, input: object): Promise<void> => {
    await api.post(path, input);

    reload();
    onChange?.();
  };

  const addGitHub = (): void => {
    save("hosts", { host: "github.com", label: "GitHub" }).then(
      () => {
        setError(undefined);
        setSettingUp("github.com");
      },
      (failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
  };

  const remove = (host: HostView): void => {
    void ask({
      title: `Remove ${host.host}?`,
      description: `Sessions will stop signing in to ${host.host}.`,
      confirm: "Remove",
      danger: true,
    }).then((yes) => {
      if (!yes) {
        return;
      }

      void api
        .delete(`hosts/${encodeURIComponent(host.host)}`)
        .then(changed, changed);
    });
  };

  const form = adding ? "new" : editing;
  const setUp = value?.find(({ host }) => host === settingUp);

  return (
    <Section
      title="Hosts"
      actions={
        !adding && (
          <Button
            onClick={() => {
              setEditing(undefined);
              onAdding(true);
            }}
          >
            <Icon name="plus" />
            Add a host
          </Button>
        )
      }
    >
      {asking}
      {form !== undefined && (
        <HostForm
          key={form === "new" ? "new" : form.host}
          host={form === "new" ? undefined : form}
          save={async (input) => {
            await save(
              form === "new"
                ? "hosts"
                : `hosts/${encodeURIComponent(form.host)}`,
              input,
            );

            changed();
          }}
          remove={
            form === "new"
              ? undefined
              : () => {
                  remove(form);
                }
          }
          cancel={() => {
            setEditing(undefined);
            onAdding(false);
          }}
        />
      )}
      <Rows label="Hosts">
        {value?.length === 0 && (
          <Row
            title="No hosts yet"
            description="Add GitHub, GitHub Enterprise or another host."
          >
            <Button variant="primary" onClick={addGitHub}>
              Add GitHub
            </Button>
          </Row>
        )}
        {value?.map((host) => (
          <Row
            key={host.host}
            initials={initialsOf(host.label)}
            title={
              <>
                {host.label}
                {host.clientId === "" ? (
                  <Badge state="waiting">Tokens only</Badge>
                ) : (
                  <Badge state="done">Sign-in ready</Badge>
                )}
              </>
            }
            description={hostDescription(host)}
          >
            <Button
              variant="ghost"
              aria-label={`Edit ${host.host}`}
              onClick={() => {
                onAdding(false);
                setEditing(host);
              }}
            >
              Edit
            </Button>
            {host.clientId === "" && settingUp !== host.host && (
              <Button
                variant="primary"
                aria-label={`Set up Connect for ${host.host}`}
                onClick={() => {
                  setSettingUp(host.host);
                }}
              >
                Set up Connect
              </Button>
            )}
          </Row>
        ))}
      </Rows>
      <ErrorText size="caption">{error}</ErrorText>
      {setUp !== undefined && (
        <ConnectSetup
          host={setUp}
          save={async (clientId, clientSecret) => {
            await save(`hosts/${encodeURIComponent(setUp.host)}`, {
              host: setUp.host,
              label: setUp.label,
              clientId,
              clientSecret,
            });
          }}
          close={() => {
            setSettingUp(undefined);
          }}
        />
      )}
    </Section>
  );
}

function hostDescription(host: HostView): string {
  const where = host.label === host.host ? kindOf(host.host) : host.host;

  return host.clientId === ""
    ? `${where} · people paste a token until a Connect button is set up`
    : `${where} · OAuth app · ${String(host.connected)} ${host.connected === 1 ? "person" : "people"} connected`;
}

export function kindOf(host: string): string {
  return host === "github.com" ? "GitHub" : "GitHub Enterprise";
}

// Registering an OAuth app on the host gives everyone a Connect button
// instead of pasting a token.
export function ConnectSetup({
  host,
  then,
  save,
  close,
}: {
  readonly host: HostView;
  // The setup step trying the sign-in comes back to.
  readonly then?: "server-setup";
  readonly save: (clientId: string, clientSecret: string) => Promise<void>;
  readonly close: () => void;
}): ReactElement {
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<string>();
  const saved = host.clientId !== "";
  const callback = `${location.origin}/api/ext/git-hosts/callback`;

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const text = (name: string): string => {
      const field = form.get(name);

      return typeof field === "string" ? field.trim() : "";
    };

    save(text("clientId"), text("clientSecret")).then(
      () => {
        setError(undefined);
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  const stepState = (step: number): StepState => {
    const at = [true, opened, saved].lastIndexOf(true) + 1;

    if (step < at) {
      return "done";
    }

    return step === at ? "current" : "next";
  };

  return (
    <section
      aria-label={`Set up Connect for ${host.host}`}
      className="flex flex-col gap-4 rounded-lg border border-dashed border-line-strong bg-elevated p-5"
    >
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-ui font-medium text-fg-strong">
          Set up Connect for {host.host}
        </h3>
        <Button variant="ghost" onClick={close}>
          {saved ? "Done" : "Cancel"}
        </Button>
      </div>
      <Stepper>
        <Step
          number={1}
          state={stepState(1)}
          title={
            <a
              href={`https://${host.host}/settings/applications/new`}
              target="_blank"
              rel="noreferrer"
              onClick={() => {
                setOpened(true);
              }}
              className="underline decoration-line-strong underline-offset-4 hover:decoration-fg"
            >
              Open the host&apos;s new OAuth app page
            </a>
          }
        >
          <span>
            Name it Pipoca, with homepage{" "}
            <code className="font-mono text-mono-sm">{location.origin}</code>{" "}
            and callback URL{" "}
            <code className="font-mono text-mono-sm break-all">{callback}</code>
            .
          </span>
        </Step>
        <Step
          number={2}
          state={stepState(2)}
          title="Paste the Client ID and secret it shows"
        >
          {!saved && (
            <form
              onSubmit={submit}
              className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
            >
              <TextInput
                name="clientId"
                required
                aria-label="Client ID"
                placeholder="Client ID"
                onFocus={() => {
                  setOpened(true);
                }}
              />
              <TextInput
                name="clientSecret"
                type="password"
                autoComplete="off"
                required
                aria-label="Client secret"
                placeholder="Client secret"
              />
              <Button variant="primary" type="submit">
                Save
              </Button>
              <ErrorText size="caption" className="sm:col-span-3">
                {error}
              </ErrorText>
            </form>
          )}
        </Step>
        <Step
          number={3}
          state={stepState(3)}
          title="Try it"
          description="We'll sign you in once to check it works."
        >
          {saved && (
            <Button
              className="mt-2 self-start"
              onClick={() => {
                signIn(host.host, then);
              }}
            >
              Connect your account
            </Button>
          )}
        </Step>
      </Stepper>
    </section>
  );
}

export function HostForm({
  host,
  label,
  save,
  remove,
  cancel,
}: {
  readonly host: HostView | undefined;
  // The label a new host starts with, such as the kind of host picked.
  readonly label?: string;
  readonly save: (input: HostInput) => Promise<void>;
  readonly remove: (() => void) | undefined;
  readonly cancel: () => void;
}): ReactElement {
  const [error, setError] = useState<string>();

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const text = (name: string): string => {
      const value = form.get(name);

      return typeof value === "string" ? value : "";
    };

    save({
      host: host?.host ?? text("host"),
      label: text("label"),
      clientId: text("clientId"),
      clientSecret:
        form.get("removeSecret") === "on" ? null : text("clientSecret"),
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };

  return (
    <form
      onSubmit={submit}
      aria-label={host ? `Edit ${host.host}` : "New host"}
      className={cn(cardClass, "grid gap-4 p-5 md:grid-cols-2")}
    >
      <Field label="Host">
        <TextInput
          name="host"
          defaultValue={host?.host ?? ""}
          disabled={host !== undefined}
          placeholder="github.example.com"
        />
      </Field>
      <Field label="Label">
        <TextInput
          name="label"
          defaultValue={host?.label ?? label ?? ""}
          placeholder="Company GitHub"
        />
      </Field>
      <Field label="OAuth app client ID (optional)">
        <TextInput name="clientId" defaultValue={host?.clientId ?? ""} />
      </Field>
      <Field label={secretLabel(host)}>
        <TextInput name="clientSecret" type="password" autoComplete="off" />
      </Field>
      {host?.hasClientSecret === true && (
        <Checkbox name="removeSecret" label="Remove the client secret" />
      )}
      <div className="flex flex-wrap items-center gap-2 md:col-span-2">
        <Button variant="primary" type="submit">
          {host ? "Save" : "Add host"}
        </Button>
        <Button onClick={cancel}>Cancel</Button>
        {remove !== undefined && (
          <Button
            variant="danger"
            className="ml-auto"
            aria-label={`Remove ${host?.host ?? ""}`}
            onClick={remove}
          >
            Remove host
          </Button>
        )}
        <ErrorText size="caption">{error}</ErrorText>
      </div>
    </form>
  );
}

function secretLabel(host: HostView | undefined): string {
  return host?.hasClientSecret === true
    ? "Client secret (set; leave empty to keep it)"
    : "OAuth app client secret";
}
