import {
  defineWeb,
  type SetupStep,
  useApi,
  useConfig,
  useLoaded,
  useViewer,
} from "@pipoca/plugins/web";
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
  linkCardClass,
  Notice,
  Page,
  plural,
  Row,
  Rows,
  Section,
  Segmented,
  Switch,
  TextArea,
  TextInput,
  useConfirm,
} from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { oidc } from "../plugin";
import type {
  Account,
  ProviderInput,
  ProviderTest,
  ProviderView,
} from "../src/model";

// How people get into a team's server, in its setup (ADR 0072). A server
// just for its person has no one else to let in.
const signInStep: SetupStep = {
  audience: "server",
  after: "plugins",
  teamOnly: true,
  title: "Sign-in",
  summary: "Identity providers and who may join",
  heading: "How people sign in",
  description:
    "Add the identity provider your team already uses, and choose who may join.",
  optional: true,
  done: async (api) =>
    (await api.get<readonly ProviderView[]>("providers")).length > 0,
  changes: ["providers"],
  Step: SignInStep,
};

export const web = defineWeb(oidc, {
  settings: { group: "server", Section: SettingsSection },
  slots: { "settings.accounts": Accounts },
  setup: [signInStep],
});

function SettingsSection(): ReactElement | null {
  if (!useViewer().person.admin) {
    return null;
  }

  return (
    <Page
      title="Sign-in"
      description="How people get into this server, and who may join."
    >
      <SignIn />
    </Page>
  );
}

function SignIn(): ReactElement | null {
  const api = useApi(oidc);

  const { value } = useLoaded(
    async () => api.get<Account>("account"),
    "account",
    { changes: ["account"] },
  );

  const providers = useLoaded(
    async () => api.get<readonly ProviderView[]>("providers"),
    "providers",
    { changes: ["providers"] },
  );

  if (value?.admin !== true) {
    return null;
  }

  return (
    <>
      {value.lockedIn !== null && <LockedNotice file={value.lockedIn} />}
      <Providers providers={providers.value} locked={value.lockedIn !== null} />
      <Rules
        account={value}
        providers={providers.value}
        locked={value.lockedIn !== null}
      />
    </>
  );
}

function SignInStep(): ReactElement {
  return (
    <div className="flex flex-col *:first:mt-0">
      <SignIn />
    </div>
  );
}

function LockedNotice({ file }: { readonly file: string }): ReactElement {
  return (
    <Notice
      icon="lock"
      className="mt-6"
      title="Some of this is set in the server's config file"
      action={
        <Button
          onClick={() => {
            location.hash = "#settings/configuration";
          }}
        >
          View file
        </Button>
      }
    >
      <code className="font-mono">{file}</code> sets oidc, so its providers and
      who can join are read-only here.
    </Notice>
  );
}

// The providers the person can sign in with, and which of them their user
// is linked to.
function Accounts(): ReactElement | null {
  const api = useApi(oidc);

  const { value, reload } = useLoaded(
    async () => api.get<Account>("account"),
    "account",
    { changes: ["account"] },
  );

  if (value === undefined || value.providers.length === 0) {
    return null;
  }

  return (
    <Section title="Sign-in">
      <Rows label="Your sign-ins">
        {value.providers.map((provider) => {
          const linked = value.identities.find(
            ({ issuer }) => issuer === provider.issuer,
          );

          return (
            <Row
              key={provider.id}
              initials={initialsOf(provider.label)}
              title={provider.label}
              description={
                linked === undefined
                  ? "Not linked"
                  : `You sign in as ${linked.email ?? "your linked account"}`
              }
            >
              {linked === undefined ? (
                <Button
                  onClick={() => {
                    location.assign(
                      `/api/ext/oidc/link/${encodeURIComponent(provider.id)}`,
                    );
                  }}
                >
                  Link account
                </Button>
              ) : (
                !linked.created && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      void api
                        .delete(
                          `identities/${encodeURIComponent(linked.issuer)}`,
                        )
                        .then(reload, reload);
                    }}
                  >
                    Unlink
                  </Button>
                )
              )}
            </Row>
          );
        })}
      </Rows>
    </Section>
  );
}

interface Preset {
  readonly name: string;
  readonly hint: string;
  readonly label: string;
  readonly issuer: string;
  readonly issuerHint: string;
  readonly groupsClaim: string;
}

const presets: readonly Preset[] = [
  {
    name: "Okta",
    hint: "Preset",
    label: "Okta",
    issuer: "",
    issuerHint: "https://your-org.okta.com",
    groupsClaim: "groups",
  },
  {
    name: "Microsoft Entra",
    hint: "Preset",
    label: "Microsoft",
    issuer: "",
    issuerHint: "https://login.microsoftonline.com/<tenant id>/v2.0",
    groupsClaim: "groups",
  },
  {
    name: "Google Workspace",
    hint: "Preset",
    label: "Google",
    issuer: "https://accounts.google.com",
    issuerHint: "https://accounts.google.com",
    groupsClaim: "",
  },
  {
    name: "Any OpenID provider",
    hint: "Issuer URL and client",
    label: "",
    issuer: "",
    issuerHint: "https://login.example.com",
    groupsClaim: "groups",
  },
];

function Providers({
  providers,
  locked,
}: {
  readonly providers: readonly ProviderView[] | undefined;
  readonly locked: boolean;
}): ReactElement {
  const api = useApi(oidc);
  const [ask, asking] = useConfirm();
  const [editing, setEditing] = useState<ProviderView | Preset>();

  const changed = (): void => {
    setEditing(undefined);
  };

  const remove = (provider: ProviderView): void => {
    void ask({
      title: `Remove ${provider.label}?`,
      description: `People won't be able to sign in with ${provider.label}.`,
      confirm: "Remove",
      danger: true,
    }).then((yes) => {
      if (!yes) {
        return;
      }

      void api
        .delete(`providers/${encodeURIComponent(provider.id)}`)
        .then(changed, changed);
    });
  };

  const existing =
    editing !== undefined && "id" in editing ? editing : undefined;

  return (
    <Section title="Company sign-in">
      {asking}
      {providers !== undefined && providers.length > 0 && (
        <Rows label="Providers">
          {providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              locked={locked}
              onEdit={() => {
                setEditing(provider);
              }}
            />
          ))}
        </Rows>
      )}
      {editing !== undefined && (
        <ProviderForm
          key={existing?.id ?? (editing as Preset).name}
          provider={existing}
          preset={existing === undefined ? (editing as Preset) : undefined}
          save={async (input) => {
            await api.post(
              existing === undefined
                ? "providers"
                : `providers/${encodeURIComponent(existing.id)}`,
              input,
            );

            changed();
          }}
          remove={
            existing &&
            (() => {
              remove(existing);
            })
          }
          cancel={() => {
            setEditing(undefined);
          }}
        />
      )}
      {!locked && (
        <ul
          aria-label="Add a provider"
          className="grid grid-cols-2 gap-2.5 md:grid-cols-4"
        >
          {presets.map((preset) => (
            <li key={preset.name}>
              <button
                type="button"
                onClick={() => {
                  setEditing(preset);
                }}
                className={cn(
                  linkCardClass,
                  "flex h-full w-full cursor-pointer flex-col items-start gap-1 px-4 py-3.5 text-left",
                )}
              >
                <span className="text-ui font-medium text-fg-strong">
                  {preset.name}
                </span>
                <span className="text-label text-fg-dim">{preset.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function ProviderRow({
  provider,
  locked,
  onEdit,
}: {
  readonly provider: ProviderView;
  readonly locked: boolean;
  readonly onEdit: () => void;
}): ReactElement {
  const api = useApi(oidc);
  const [test, setTest] = useState<ProviderTest | "testing">();
  const people = provider.signedInThisWeek;

  const badge = (): ReactElement | null => {
    if (test === "testing") {
      return <Badge state="working">Testing</Badge>;
    }

    if (test?.ok === false) {
      return <Badge state="failed">Can&apos;t reach it</Badge>;
    }

    return test?.ok === true || people > 0 ? (
      <Badge state="done">Working</Badge>
    ) : null;
  };

  return (
    <Row
      initials={initialsOf(provider.label)}
      title={
        <>
          {provider.label}
          {badge()}
          {locked && <Badge>Set in deploy file</Badge>}
        </>
      }
      description={
        <span className="flex flex-col gap-0.5">
          <span className="font-mono">
            {provider.issuer} · {plural(people, "person", "people")} signed in
            this week
          </span>
          {typeof test === "object" && test.error !== null && (
            <ErrorText inline size="inherit">
              {test.error}
            </ErrorText>
          )}
        </span>
      }
    >
      <Button
        variant="ghost"
        aria-label={`Test ${provider.label}`}
        onClick={() => {
          setTest("testing");

          api
            .post<ProviderTest>(
              `providers/${encodeURIComponent(provider.id)}/test`,
            )
            .then(setTest, (reason: unknown) => {
              setTest({
                ok: false,
                error:
                  reason instanceof Error ? reason.message : String(reason),
              });
            });
        }}
      >
        Test
      </Button>
      {!locked && (
        <Button
          variant="ghost"
          aria-label={`Edit ${provider.label}`}
          onClick={onEdit}
        >
          Edit
        </Button>
      )}
    </Row>
  );
}

function Rules({
  account,
  providers,
  locked,
}: {
  readonly account: Account;
  readonly providers: readonly ProviderView[] | undefined;
  readonly locked: boolean;
}): ReactElement {
  const api = useApi(oidc);
  const [error, setError] = useState<string>();
  const [only] = providers?.length === 1 ? providers : [];

  // The domain the admin's own company account is at, for one provider.
  const domain =
    only?.allowedDomains[0] ??
    account.identities
      .find(({ issuer }) => issuer === only?.issuer)
      ?.email?.split("@")[1];

  const setDomain = (domains: readonly string[]): void => {
    if (only === undefined) {
      return;
    }

    const input: ProviderInput = {
      label: only.label,
      issuer: only.issuer,
      clientId: only.clientId,
      clientSecret: "",
      groupsClaim: only.groupsClaim,
      accessGroup: only.accessGroup,
      adminGroup: only.adminGroup,
      allowedEmails: only.allowedEmails,
      allowedDomains: domains,
      adminEmails: only.adminEmails,
    };

    api.post(`providers/${encodeURIComponent(only.id)}`, input).then(
      () => {
        setError(undefined);
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  return (
    <Section title="Rules">
      <Rows label="Rules">
        <Row
          title="Passwords"
          description={
            account.passwordLogin
              ? "People without company sign-in use a name and password"
              : "Turned off while company sign-in is required"
          }
        >
          <Switch
            label="Passwords"
            labelHidden
            checked={account.passwordLogin}
            disabled
            onChange={() => undefined}
          />
        </Row>
        <Row
          title={
            <>
              Require company sign-in
              <Icon name="lock" />
            </>
          }
          description="Set when the server starts, by --sso-only or the Helm chart's oidc.ssoOnly"
        >
          <Switch
            label="Require company sign-in"
            labelHidden
            checked={!account.passwordLogin}
            disabled
            onChange={() => undefined}
          />
        </Row>
        <Row
          title="Who can join"
          description={
            <>
              {whoMayJoin(providers ?? [])}
              <ErrorText inline size="inherit" className="block">
                {error}
              </ErrorText>
            </>
          }
        >
          {!locked && only !== undefined && domain !== undefined && (
            <Segmented
              label="Who can join"
              value={only.allowedDomains.length > 0 ? "domain" : "invited"}
              onChange={(chosen) => {
                setDomain(chosen === "domain" ? [domain] : []);
              }}
              options={[
                { value: "invited", label: "Invited people" },
                { value: "domain", label: `Anyone at ${domain}` },
              ]}
            />
          )}
        </Row>
      </Rows>
    </Section>
  );
}

function whoMayJoin(providers: readonly ProviderView[]): string {
  const who = providers.flatMap((provider) => [
    ...(provider.accessGroup === ""
      ? []
      : [`the ${provider.accessGroup} group`]),
    ...provider.allowedDomains.map((domain) => `anyone at ${domain}`),
    ...provider.allowedEmails,
  ]);

  return who.length === 0
    ? "Anyone else needs an invite"
    : `Also ${who.join(", ")}. Anyone else needs an invite`;
}

function ProviderForm({
  provider,
  preset,
  save,
  remove,
  cancel,
}: {
  readonly provider: ProviderView | undefined;
  readonly preset: Preset | undefined;
  readonly save: (input: ProviderInput) => Promise<void>;
  readonly remove: (() => void) | undefined;
  readonly cancel: () => void;
}): ReactElement {
  const [error, setError] = useState<string>();
  const secret = useSecretRef(provider?.id);

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const text = (name: string): string => {
      const value = form.get(name);

      return typeof value === "string" ? value : "";
    };

    const list = (name: string): readonly string[] =>
      text(name)
        .split(/[\s,]+/)
        .filter((each) => each !== "");

    const input: ProviderInput = {
      label: text("label"),
      issuer: text("issuer"),
      clientId: text("clientId"),
      clientSecret:
        form.get("removeSecret") === "on" ? null : text("clientSecret"),
      groupsClaim: text("groupsClaim"),
      accessGroup: text("accessGroup"),
      adminGroup: text("adminGroup"),
      allowedEmails: list("allowedEmails"),
      allowedDomains: list("allowedDomains"),
      adminEmails: list("adminEmails"),
    };

    save(input).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };

  const starting: Readonly<Record<string, string>> = {
    label: preset?.label ?? "",
    issuer: preset?.issuer ?? "",
    groupsClaim: preset?.groupsClaim ?? "",
  };

  const textField = (
    name:
      | "label"
      | "issuer"
      | "clientId"
      | "groupsClaim"
      | "accessGroup"
      | "adminGroup",
    label: string,
    placeholder?: string,
  ): ReactElement => (
    <Field label={label}>
      <TextInput
        name={name}
        defaultValue={provider?.[name] ?? starting[name]}
        placeholder={placeholder}
      />
    </Field>
  );

  const listField = (
    name: "allowedEmails" | "allowedDomains" | "adminEmails",
    label: string,
    placeholder: string,
  ): ReactElement => (
    <Field label={label}>
      <TextArea
        name={name}
        rows={2}
        defaultValue={provider?.[name].join("\n") ?? ""}
        placeholder={placeholder}
      />
    </Field>
  );

  return (
    <form
      onSubmit={submit}
      aria-label={
        provider
          ? `Edit ${provider.label}`
          : `New ${preset?.name ?? ""} sign-in`
      }
      className={cn(cardClass, "grid gap-4 p-5 md:grid-cols-2")}
    >
      {textField("label", "Button label", "Sign in with Company SSO")}
      {textField(
        "issuer",
        "Issuer",
        preset?.issuerHint ?? "https://login.example.com",
      )}
      {textField("clientId", "Client ID")}
      <Field label={secretLabel(provider, secret)}>
        <TextInput name="clientSecret" type="password" autoComplete="off" />
      </Field>
      {textField("groupsClaim", "Groups claim", "groups")}
      {textField("accessGroup", "Access group", "pipoca-users")}
      {textField("adminGroup", "Admin group", "pipoca-admins")}
      {listField("allowedEmails", "Allowed emails", "ana@example.com")}
      {listField("allowedDomains", "Allowed domains", "example.com")}
      {listField("adminEmails", "Admin emails", "ana@example.com")}
      {provider?.hasClientSecret === true && (
        <Checkbox name="removeSecret" label="Remove the client secret" />
      )}
      <div className="flex flex-wrap items-center gap-2 md:col-span-2">
        <Button variant="primary" type="submit">
          {provider ? "Save" : "Add provider"}
        </Button>
        <Button onClick={cancel}>Cancel</Button>
        {remove !== undefined && provider !== undefined && (
          <Button
            variant="ghost"
            aria-label={`Remove ${provider.label}`}
            className="ml-auto"
            onClick={remove}
          >
            Remove
          </Button>
        )}
        <ErrorText size="caption">{error}</ErrorText>
      </div>
      <p className="text-caption text-fg-dim md:col-span-2">
        Register{" "}
        <code className="font-mono text-mono-sm">
          {location.origin}/api/ext/oidc/callback
        </code>{" "}
        as the redirect URI with the provider.
      </p>
    </form>
  );
}

// How the file holds the provider's client secret, such as { env: "NAME" }.
function useSecretRef(id: string | undefined): unknown {
  const config = useConfig(oidc);
  const listed: unknown = config?.["providers"];

  return Array.isArray(listed)
    ? (listed as readonly { id?: unknown; clientSecret?: unknown }[]).find(
        (each) => each.id === id,
      )?.clientSecret
    : undefined;
}

function secretLabel(provider: ProviderView | undefined, ref: unknown): string {
  if (typeof ref === "object" && ref !== null && "env" in ref) {
    return `Client secret (from ${String(ref.env)}; leave empty to keep it)`;
  }

  return provider?.hasClientSecret === true
    ? "Client secret (set; leave empty to keep it)"
    : "Client secret (only if the provider requires one)";
}
