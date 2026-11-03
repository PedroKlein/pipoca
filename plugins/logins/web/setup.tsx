import {
  json,
  type SetupStep,
  useLoaded,
  type WebContext,
} from "@pipoca/plugins/web";
import {
  Badge,
  Button,
  cn,
  initialsOf,
  Picker,
  Row,
  Rows,
  Segmented,
} from "@pipoca/ui";
import type { Environment } from "@pipoca/protocol";
import { type ReactElement, useState } from "react";
import type { Account, Connectable } from "../src/model";
import { ConnectionCard } from "./connect";

// The providers most people pick first. Any other is one search away.
const featured = [
  "anthropic",
  "openai",
  "github-copilot",
  "google",
  "openrouter",
  "amazon-bedrock",
  "mistral",
];

// Connecting a model in the setup runs the same sign-in as Accounts, with no
// Session needed (ADR 0063).
export const modelStep: SetupStep = {
  title: "A model",
  summary: "Sign in with a subscription or add a key",
  heading: "Connect a model",
  description:
    "Pick who runs the thinking. Your login stays on this server and works on every machine you connect.",
  // A runner's own login counts too, as it did before the setup.
  done: async (context) =>
    (await json<Environment[]>(context.request("/api/environments"))).some(
      ({ models }) => models.length > 0,
    ),
  topics: ["logins.logins", "environments"],
  wide: true,
  Step: ModelStep,
};

function ModelStep({
  context,
}: {
  readonly context: WebContext;
}): ReactElement | null {
  const { value: account, reload } = useLoaded(
    async () => json<Account>(context.request("account")),
    "account",
    { topics: ["logins.logins"] },
  );

  const { value: providers } = useLoaded(
    async () => json<readonly Connectable[]>(context.request("providers")),
    "providers",
  );

  const [chosen, setChosen] = useState<string>();
  const [method, setMethod] = useState<string>();
  const [error, setError] = useState<string>();

  if (account === undefined || providers === undefined) {
    return null;
  }

  const provider = providers.find(({ id }) => id === chosen);

  const rank = (id: string): number =>
    featured.includes(id) ? featured.indexOf(id) : featured.length;

  const shown = providers
    .filter(({ id }) => featured.includes(id) || id === chosen)
    .toSorted((a, b) => rank(a.id) - rank(b.id));

  const choose = (id: string): void => {
    setChosen(id);
    setMethod(providers.find((each) => each.id === id)?.methods[0]?.type);
  };

  const type = provider?.methods.find((each) => each.type === method)?.type;

  const send = (path: string, init: RequestInit): void => {
    json(context.request(path, init)).then(
      () => {
        setError(undefined);
        reload();
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        reload();
      },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <ul
        aria-label="Model providers"
        className="grid grid-cols-2 gap-2.5 md:grid-cols-4"
      >
        {shown.map((each) => (
          <li key={each.id}>
            <button
              type="button"
              aria-pressed={each.id === chosen}
              onClick={() => {
                choose(each.id);
              }}
              className={cn(
                "flex h-full w-full cursor-pointer flex-col items-start gap-2 rounded-lg border border-line bg-elevated p-3.5 text-left hover:border-line-strong",
                "aria-pressed:border-fg-strong aria-pressed:shadow-xs",
              )}
            >
              <span
                aria-hidden="true"
                className="grid size-8.5 place-items-center rounded-md border border-line bg-hover text-label font-semibold text-fg-strong"
              >
                {initialsOf(each.name)}
              </span>
              <span className="text-ui font-medium text-fg-strong">
                {each.name}
              </span>
              <span className="text-label text-fg-dim">
                {each.methods.map(({ label }) => label).join(" or ")}
              </span>
            </button>
          </li>
        ))}
        <li className="flex flex-col items-start justify-center gap-2 rounded-lg border border-dashed border-line-strong p-3.5">
          <span className="text-ui font-medium text-fg-strong">
            Another provider
          </span>
          <Picker
            label="Another provider"
            placeholder="Search providers"
            options={providers.map(({ id, name }) => ({
              value: id,
              label: name,
            }))}
            selected={chosen === undefined ? [] : [chosen]}
            onChange={([id]) => {
              if (id !== undefined) {
                choose(id);
              }
            }}
          >
            All {providers.length} providers
          </Picker>
        </li>
      </ul>
      <p className="text-caption text-fg-dim">
        Every sign-in happens right here, with no Session needed. You can
        connect more than one.
      </p>
      {account.connection !== undefined && (
        <ConnectionCard connection={account.connection} send={send} />
      )}
      {account.connection === undefined && provider !== undefined && (
        <section
          aria-label={`Connect ${provider.name}`}
          className="flex flex-col items-start gap-3 rounded-lg border border-line bg-elevated p-5 shadow-xs"
        >
          {provider.methods.length > 1 && (
            <Segmented
              label="Sign in with"
              value={type ?? ""}
              options={provider.methods.map(({ type: value, label }) => ({
                value,
                label,
              }))}
              onChange={setMethod}
            />
          )}
          <Button
            variant="primary"
            onClick={() => {
              send("connect", {
                method: "POST",
                body: JSON.stringify({ provider: provider.id, type }),
              });
            }}
          >
            Connect {provider.name}
          </Button>
        </section>
      )}
      {error !== undefined && (
        <p role="alert" className="text-caption text-failed">
          {error}
        </p>
      )}
      {account.logins.length > 0 && (
        <Rows label="Your model logins">
          {account.logins.map((login) => (
            <Row
              key={login.provider}
              initials={initialsOf(login.provider)}
              title={
                <>
                  {login.provider}
                  <Badge state="done">
                    {login.type === "oauth" ? "Signed in" : "Key saved"}
                  </Badge>
                </>
              }
            />
          ))}
        </Rows>
      )}
    </div>
  );
}
