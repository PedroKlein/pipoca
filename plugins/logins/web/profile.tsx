import { json, useLoaded, type WebContext } from "@pipoca/plugins/web";
import type { Profile } from "@pipoca/protocol";
import { Badge, ErrorText, initialsOf, Row, Rows, Section, Segmented } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import type { Account, Connectable, LoginLayer } from "../src/model";
import { ConnectForm, ConnectionCard } from "./connect";
import { layerName } from "./layers";

interface Line {
  readonly kind: "model" | "mcp";
  readonly key: string;
  readonly name: string;
  readonly type?: string;
  readonly own: boolean;
  readonly from: LoginLayer | undefined;
}

// A Profile inherits each login from the layers below it, or signs in with
// an account of its own (ADR 0063).
export function ProfileLogins({
  context,
  profileId,
}: {
  readonly context: WebContext;
  readonly profileId: string;
}): ReactElement | null {
  const { value: account, reload } = useLoaded(
    async () => json<Account>(context.request("account")),
    "account",
    { topics: ["logins.logins"] },
  );

  const { value: profiles } = useLoaded(
    async () => json<readonly Profile[]>(context.request("/api/profiles")),
    "profiles",
    { topics: ["profiles"] },
  );

  const { value: providers = [] } = useLoaded(
    async () => json<readonly Connectable[]>(context.request("providers")),
    "providers",
  );

  const [choosing, setChoosing] = useState<string>();
  const [error, setError] = useState<string>();

  if (account === undefined || profiles === undefined) {
    return null;
  }

  const own: LoginLayer = `profile:${profileId}`;

  const below: readonly LoginLayer[] = [
    ...chainOf(profileId, profiles).map((id): LoginLayer => `profile:${id}`),
    "defaults",
    "base",
  ];

  const lineOf = (
    kind: Line["kind"],
    key: string,
    name: string,
    layers: readonly LoginLayer[],
  ): Line => ({
    kind,
    key,
    name,
    own: layers.includes(own),
    from: below.find((layer) => layers.includes(layer)),
  });

  const layersOf = (
    entries: readonly { readonly key: string; readonly layer: LoginLayer }[],
    key: string,
  ): readonly LoginLayer[] =>
    entries.filter((entry) => entry.key === key).map(({ layer }) => layer);

  const relevant = new Set<LoginLayer>([own, ...below]);

  const models = account.logins
    .filter(({ layer }) => relevant.has(layer))
    .map(({ provider, layer }) => ({ key: provider, layer }));

  const mcp = account.mcp
    .filter(({ layer }) => relevant.has(layer))
    .map(({ server, layer }) => ({ key: server, layer }));

  const lines = [
    ...unique(models.map(({ key }) => key)).map((key) => {
      const line = lineOf(
        "model",
        key,
        providers.find(({ id }) => id === key)?.name ?? key,
        layersOf(models, key),
      );

      const from = line.own ? own : line.from;

      const type = account.logins.find(
        (login) => login.provider === key && login.layer === from,
      )?.type;

      return type === undefined ? line : { ...line, type: typeLabels[type] };
    }),
    ...unique([
      ...account.servers.map(({ key }) => key),
      ...mcp.map(({ key }) => key),
    ]).map((key) =>
      lineOf("mcp", key, key.split(" ")[0] ?? key, layersOf(mcp, key)),
    ),
  ];

  const send = (path: string, init: RequestInit): void => {
    json(context.request(path, init)).then(
      () => {
        setChoosing(undefined);
        setError(undefined);
        reload();
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        reload();
      },
    );
  };

  const choose = (line: Line, value: "inherit" | "own"): void => {
    if (value === "inherit") {
      setChoosing(undefined);

      if (line.own) {
        send(
          `${line.kind === "model" ? "credentials" : "mcp"}/${encodeURIComponent(line.key)}?layer=${own}`,
          { method: "DELETE" },
        );
      }

      return;
    }

    if (line.kind === "mcp") {
      send("connect-mcp", {
        method: "POST",
        body: JSON.stringify({ server: line.key, layer: own }),
      });

      return;
    }

    setChoosing(line.key);
  };

  return (
    <Section
      title="Logins"
      description="Inherit them, or sign in with another account just for this Profile"
    >
      {account.connection !== undefined && (
        <ConnectionCard connection={account.connection} send={send} />
      )}
      {account.connection === undefined && choosing !== undefined && (
        <ConnectForm
          context={context}
          send={send}
          provider={choosing}
          layer={own}
          onClose={() => {
            setChoosing(undefined);
          }}
        />
      )}
      <ErrorText size="caption">{error}</ErrorText>
      <Rows label="This Profile's logins">
        {lines.length === 0 && (
          <Row
            title="No logins yet"
            description="Sign in on Accounts, and this Profile inherits them."
          />
        )}
        {lines.map((line) => (
          <Row
            key={`${line.kind} ${line.key}`}
            initials={initialsOf(line.name)}
            title={
              <>
                {line.name}
                {line.kind === "mcp" && <Badge state="offline">MCP</Badge>}
              </>
            }
            description={describe(line, profiles)}
          >
            <Segmented
              label={`${line.name} login`}
              value={line.own || choosing === line.key ? "own" : "inherit"}
              options={[
                { value: "inherit", label: "Inherit" },
                { value: "own", label: "Own login" },
              ]}
              onChange={(value) => {
                choose(line, value);
              }}
            />
          </Row>
        ))}
      </Rows>
    </Section>
  );
}

const typeLabels = {
  oauth: "Subscription",
  api_key: "API key",
} as const;

function describe(line: Line, profiles: readonly Profile[]): string {
  if (!line.own && line.from === undefined) {
    return "Not signed in";
  }

  const where =
    line.from === undefined || line.own
      ? "its own login"
      : `from ${layerName(line.from, profiles)}`;

  return line.type === undefined
    ? where.charAt(0).toUpperCase() + where.slice(1)
    : `${line.type}, ${where}`;
}

// The Profiles this one builds on, nearest first, as far as they're listed.
function chainOf(id: string, profiles: readonly Profile[]): readonly string[] {
  const found: string[] = [];

  for (
    let next = profiles.find((profile) => profile.id === id)?.buildsOn;
    next !== null && next !== undefined && !found.includes(next) && next !== id;
    next = profiles.find((profile) => profile.id === next)?.buildsOn
  ) {
    found.push(next);
  }

  return found;
}

function unique(keys: readonly string[]): readonly string[] {
  return [...new Set(keys)].sort();
}
