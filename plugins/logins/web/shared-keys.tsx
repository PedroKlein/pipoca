import { logins } from "../plugin";
import { useLoaded, useApi } from "@pipoca/plugins/web";
import {
  Button,
  ErrorText,
  Icon,
  initialsOf,
  Notice,
  Picker,
  Row,
  Rows,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import type { Account, Connectable } from "../src/model";
import { ConnectionCard, PasteKey, useSend } from "./connect";

interface TeamKey {
  readonly provider: string;
  readonly proxied: boolean;
}

// The API keys an admin puts on the server base for the providers the server
// pays for (ADR 0066, ADR 0072). Any provider Pi knows, or a package of the
// server default Profile adds, may be one, and none is an answer too.
export function SharedKeysStep(): ReactElement | null {
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

  const { value: keys = [] } = useLoaded(
    async () => api.get<readonly TeamKey[]>("keys"),
    "keys",
    { changes: ["logins"] },
  );

  const { send, error } = useSend(reload);
  const [pasting, setPasting] = useState<Connectable>();

  if (account === undefined || providers === undefined) {
    return null;
  }

  const nameOf = (id: string): string =>
    providers.find((each) => each.id === id)?.name ?? id;

  const shared = account.logins.filter(({ layer }) => layer === "base");
  const keyed = new Set(shared.map(({ provider }) => provider));

  const offered = providers.filter(
    ({ id, methods }) =>
      !keyed.has(id) && methods.some(({ type }) => type === "api_key"),
  );

  const running = account.connection?.state === "running";

  const add = (id: string): void => {
    const provider = offered.find((each) => each.id === id);

    if (provider?.paste === true) {
      setPasting(provider);

      return;
    }

    setPasting(undefined);
    send(api.post("connect", { provider: id, type: "api_key", layer: "base" }));
  };

  return (
    <div className="flex flex-col gap-6">
      <Rows label="Shared model keys">
        {shared.length === 0 && (
          <Row
            title="No shared key yet"
            description="Everyone signs in with their own account or key. You can add one here any time from Settings, Accounts."
          />
        )}
        {shared.map(({ provider }) => {
          const name = nameOf(provider);

          const proxied = keys.some(
            (each) => each.provider === provider && each.proxied,
          );

          return (
            <Row
              key={provider}
              initials={initialsOf(name)}
              title={name}
              description={
                proxied
                  ? "API key. Team Sessions reach it through the server, which never hands it out."
                  : "API key"
              }
            >
              <Button
                variant="ghost"
                iconOnly
                aria-label={`Remove the ${name} key`}
                onClick={() => {
                  send(
                    api.delete(
                      `credentials/${encodeURIComponent(provider)}?layer=base`,
                    ),
                  );
                }}
              >
                <Icon name="x" />
              </Button>
              {!proxied && (
                <Notice tone="waiting" className="basis-full">
                  {providers.some(
                    (each) => each.id === provider && each.paste !== true,
                  )
                    ? "The server can't carry this provider's calls"
                    : "Added by a package"}
                  , so this key goes to team runners instead of through the
                  server&apos;s key proxy.
                </Notice>
              )}
            </Row>
          );
        })}
      </Rows>
      {account.connection !== undefined && (
        <ConnectionCard connection={account.connection} send={send} />
      )}
      {pasting !== undefined && (
        <PasteKey
          provider={pasting}
          layer="base"
          send={send}
          onClose={() => {
            setPasting(undefined);
          }}
        />
      )}
      <ErrorText size="caption">{error}</ErrorText>
      <div className="flex flex-col items-start gap-2">
        {!running && (
          <Picker
            label="Add a shared key"
            placeholder="Search providers"
            options={offered.map(({ id, name, paste }) => ({
              value: id,
              label: name,
              detail: paste === true ? "Added by a package" : "Pi",
            }))}
            selected={[]}
            onChange={([id]) => {
              if (id !== undefined) {
                add(id);
              }
            }}
          >
            <span className="inline-flex items-center gap-1.5">
              <Icon name="plus" />
              Add a shared key
            </span>
          </Picker>
        )}
        <p className="text-caption text-fg-dim">
          Every provider Pi knows, plus any the server default Profile&apos;s
          packages add once a runner has installed them. Missing one? Add its
          package to the server default Profile, the step before this one.
        </p>
      </div>
    </div>
  );
}
