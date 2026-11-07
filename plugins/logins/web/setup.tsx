import { logins } from "../plugin";
import {
  type SetupStep,
  type SetupStepProps,
  useLoaded,
  useApi,
} from "@pipoca/plugins/web";
import type { TypedClient } from "@pipoca/plugins";
import {
  Badge,
  Button,
  ErrorText,
  Field,
  Icon,
  initialsOf,
  Notice,
  Row,
  Rows,
  TextInput,
} from "@pipoca/ui";
import type { Environment, ProfileContent } from "@pipoca/protocol";
import { type ReactElement, type SubmitEvent, useState } from "react";
import type { Account, Connectable } from "../src/model";
import { ConnectionCard, PasteKey, useSend } from "./connect";
import { SharedKeysStep } from "./shared-keys";

// The rows the list shows before Show all.
const shortList = 5;

// The server's shared keys, set once by an admin (ADR 0072). None is an
// answer, since everyone can sign in on their own.
export const sharedKeysStep: SetupStep = {
  audience: "server",
  after: "default-profile",
  title: "Shared model keys",
  summary: "Providers the server pays for",
  heading: "Shared model keys",
  description:
    "Only for providers the server pays for. Everyone can use them, and team Sessions run on them. People still sign in to any provider on their own in their setup, so you can leave this empty.",
  done: async () => Promise.resolve(true),
  Step: SharedKeysStep,
};

// A model the person's Sessions can use: a shared key, a login of their own
// or a runner's own login, as before the setup.
export async function hasModel(api: TypedClient): Promise<boolean> {
  const [account, environments] = await Promise.all([
    api.get<Account>("account"),
    api.get<readonly Environment[]>("/api/environments"),
  ]);

  return (
    account.logins.some(
      ({ layer }) => layer === "base" || layer === "defaults",
    ) || environments.some(({ models }) => models.length > 0)
  );
}

// Every sign-in runs here, as in Accounts, with no Session needed
// (ADR 0063). On a server just for its person, their keys are the shared
// ones too.
export const modelStep: SetupStep = {
  audience: "person",
  after: "welcome",
  title: "Your models",
  summary: "Sign in with your own account or key",
  heading: "Your models",
  description:
    "Sign in to any provider with your own account or key. Your logins stay on this server and work on every machine you connect.",
  optional: true,
  done: hasModel,
  topics: ["environments"],
  changes: ["logins"],
  wide: true,
  Step: ModelStep,
};

function ModelStep({ solo }: SetupStepProps): ReactElement | null {
  const api = useApi(logins);

  const { value: account, reload } = useLoaded(
    async () => api.get<Account>("account"),
    "account",
    { changes: ["logins"] },
  );

  const { value: providers } = useLoaded(
    async () => api.get<readonly Connectable[]>("providers"),
    "providers",
    { topics: ["environments"] },
  );

  const { send, error } = useSend(reload);
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const [pasting, setPasting] = useState<Connectable>();

  if (account === undefined || providers === undefined) {
    return null;
  }

  // On a server just for its person, their API keys go on the base, so
  // the server's own work runs on them too.
  const keyLayer = solo && account.admin ? "base" : "defaults";

  const mine = account.logins.filter(
    ({ layer }) => layer === "defaults" || (solo && layer === "base"),
  );

  const shared = solo
    ? []
    : account.logins.filter(({ layer }) => layer === "base");

  const nameOf = (id: string): string =>
    providers.find((each) => each.id === id)?.name ?? id;

  const loginOf = (id: string): Account["logins"][number] | undefined =>
    mine.find(({ provider }) => provider === id);

  // The person's own first, then ones a package adds, then Pi's that sign
  // in with an account, such as a subscription, then the rest, each in Pi's
  // own order.
  const rank = ({ id, paste, methods }: Connectable): number => {
    if (loginOf(id) !== undefined) {
      return 0;
    }

    if (paste === true) {
      return 1;
    }

    return methods.some(({ type }) => type === "oauth") ? 2 : 3;
  };

  const ordered = providers.toSorted((a, b) => rank(a) - rank(b));
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  const matching = ordered.filter(({ id, name }) =>
    words.every((word) => `${name} ${id}`.toLowerCase().includes(word)),
  );

  const pinned = ordered.filter((each) => rank(each) < 2).length;
  const folded = words.length === 0 && !all;
  const limit = Math.max(shortList, pinned);
  const shown = folded ? matching.slice(0, limit) : matching;
  const running = account.connection?.state === "running";

  const start = (provider: Connectable, type: "oauth" | "api_key"): void => {
    if (provider.paste === true) {
      setPasting(provider);

      return;
    }

    setPasting(undefined);

    send(
      api.post("connect", {
        provider: provider.id,
        type,
        layer: type === "api_key" ? keyLayer : "defaults",
      }),
    );
  };

  return (
    <div className="flex flex-col gap-6">
      {shared.length > 0 && (
        <section className="flex flex-col gap-2.5" aria-label="Shared">
          <h2 className="text-label font-medium text-fg-strong">
            Shared by the server
          </h2>
          <p className="text-caption text-fg-dim">
            The server pays for these, so you can just continue.
          </p>
          <Rows label="Shared by the server">
            {shared.map(({ provider }) => (
              <Row
                key={provider}
                initials={initialsOf(nameOf(provider))}
                title={nameOf(provider)}
                description="A shared key for everyone on this server"
              >
                <Badge state="done">Ready</Badge>
              </Row>
            ))}
          </Rows>
        </section>
      )}
      <section className="flex flex-col gap-2.5" aria-label="Yours">
        <h2 className="text-label font-medium text-fg-strong">
          {solo ? "Your providers" : "Yours"}
        </h2>
        <div className="relative">
          <Icon
            name="search"
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-dim"
          />
          <TextInput
            type="search"
            aria-label="Search providers"
            placeholder="Search every provider Pi knows"
            value={query}
            className="w-full pl-9"
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </div>
        {account.connection !== undefined && (
          <ConnectionCard connection={account.connection} send={send} />
        )}
        {pasting !== undefined && (
          <PasteKey
            provider={pasting}
            layer={keyLayer}
            send={send}
            onClose={() => {
              setPasting(undefined);
            }}
          />
        )}
        <ErrorText size="caption">{error}</ErrorText>
        <Rows label="Model providers">
          {shown.length === 0 && (
            <Row
              title="No provider matches"
              description="Pi doesn't know it yet. Add its package below."
            />
          )}
          {shown.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              login={loginOf(provider.id)}
              shared={shared.some((each) => each.provider === provider.id)}
              busy={running}
              onStart={(type) => {
                start(provider, type);
              }}
            />
          ))}
          {folded && matching.length > shown.length && (
            <Row
              title={
                <span className="font-normal text-fg-dim">
                  {matching.length - shown.length} more providers
                </span>
              }
            >
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setAll(true);
                }}
              >
                Show all
              </Button>
            </Row>
          )}
        </Rows>
        <AddPackage />
      </section>
    </div>
  );
}

function ProviderRow({
  provider,
  login,
  shared,
  busy,
  onStart,
}: {
  readonly provider: Connectable;
  readonly login: Account["logins"][number] | undefined;
  readonly shared: boolean;
  readonly busy: boolean;
  readonly onStart: (type: "oauth" | "api_key") => void;
}): ReactElement {
  const { name, methods } = provider;
  const ways = methods.map(({ label }) => label).join(" or ");

  const description = (): string => {
    if (login !== undefined) {
      return login.type === "oauth"
        ? "Signed in with your account"
        : "Your API key";
    }

    if (provider.paste === true) {
      return "Added by a package. Paste its key.";
    }

    return shared ? `${ways}, used instead of the shared key` : ways;
  };

  return (
    <Row
      initials={initialsOf(name)}
      title={
        <>
          {name}
          {login !== undefined && (
            <Badge state="done">
              {login.type === "oauth" ? "Signed in" : "Key saved"}
            </Badge>
          )}
        </>
      }
      description={description()}
    >
      {login === undefined &&
        methods.map(({ type }) => (
          <Button
            key={type}
            size="sm"
            disabled={busy}
            aria-label={
              type === "oauth" ? `Sign in to ${name}` : `Add a key for ${name}`
            }
            onClick={() => {
              onStart(type);
            }}
          >
            {type === "oauth" ? "Sign in" : "Add key"}
          </Button>
        ))}
    </Row>
  );
}

// A provider Pi doesn't know comes from a package. It goes into the
// person's default Profile (ADR 0063), and its runners list the provider
// once they install it.
function AddPackage(): ReactElement {
  const api = useApi(logins);
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState("");
  const [added, setAdded] = useState<string>();
  const [error, setError] = useState<string>();

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const wanted = source.trim();

    if (wanted === "") {
      return;
    }

    void (async () => {
      const defaults = await api.get<ProfileContent>(
        "/api/me/profile-defaults",
      );

      await api.put("/api/me/profile-defaults", {
        packages: [...defaults.packages, wanted],
      });
    })().then(
      () => {
        setAdded(wanted);
        setSource("");
        setOpen(false);
        setError(undefined);
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  return (
    <div className="flex flex-col gap-2.5">
      <Rows label="A provider Pi doesn't know">
        <Row
          initials="Pk"
          title="A provider Pi doesn't know"
          description="Add its package (npm or git). It goes to your default Profile, and its sign-in shows up in this list once a runner installs it."
        >
          {!open && (
            <Button
              size="sm"
              onClick={() => {
                setOpen(true);
              }}
            >
              Add package
            </Button>
          )}
        </Row>
      </Rows>
      {open && (
        <form
          aria-label="Add a provider's package"
          onSubmit={submit}
          className="flex flex-col gap-2"
        >
          <Field
            label="Package"
            hint="An npm name, a git URL or a path, as Pi's settings take it."
            error={error}
          >
            <div className="flex gap-2">
              <TextInput
                name="source"
                value={source}
                placeholder="npm:… or git:…"
                className="flex-1 font-mono text-mono-sm"
                onChange={(event) => {
                  setSource(event.target.value);
                }}
              />
              <Button variant="primary" type="submit">
                Add
              </Button>
              <Button
                onClick={() => {
                  setOpen(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </Field>
        </form>
      )}
      {added !== undefined && (
        <Notice tone="done" role="status">
          Added {added} to your default Profile. Its provider shows up here once
          a runner installs it, with your next Session.
        </Notice>
      )}
    </div>
  );
}
