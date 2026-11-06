import { logins } from "../plugin";
import { useLoaded, useApi } from "@pipoca/plugins/web";
import type { Environment, Profile, ProfileContent } from "@pipoca/protocol";
import { Badge, initialsOf, PageTitle, Row, Rows, Section } from "@pipoca/ui";
import type { ReactElement } from "react";

interface TeamKey {
  readonly provider: string;
  readonly proxied: boolean;
}

interface Reaching {
  readonly key: string;
  readonly title: string;
  readonly description: string;
}

// The team's credentials and where each one goes: keys the proxy holds for
// team work, and secrets that still reach its runners (ADR 0066).
export function TeamCredentials(): ReactElement {
  const api = useApi(logins);

  const { value: keys = [] } = useLoaded(
    async () => api.get<readonly TeamKey[]>("keys"),
    "keys",
    { topics: ["logins.logins"] },
  );

  const { value: loaded } = useLoaded(
    async () => {
      const [profiles, base, environments] = await Promise.all([
        api.get<readonly Profile[]>("/api/profiles?scope=team"),
        api.get<ProfileContent>("/api/settings/base-profile"),
        api.get<readonly Environment[]>("/api/environments?scope=team"),
      ]);

      return {
        environments,
        secrets: [
          ...mcpSecrets("Server base", base),
          ...profiles.flatMap((profile) => mcpSecrets(profile.name, profile)),
          ...environments
            .filter(({ secrets }) => secrets.length > 0)
            .map(({ id, name, secrets }) => ({
              key: `environment:${id}`,
              title: name,
              description: `Environment secrets ${secrets.join(", ")}`,
            })),
        ],
      };
    },
    "reaching",
    { topics: ["profiles", "environments"] },
  );

  const proxied = keys.filter(({ proxied: through }) => through);
  const handed = keys.filter(({ proxied: through }) => !through);

  const reaching = [
    ...(loaded?.secrets ?? []),
    ...handed.map(({ provider }) => ({
      key: `key:${provider}`,
      title: provider,
      description:
        "Key on the Server base. The server can't carry this provider's calls, so every team Session's runner gets the key.",
    })),
  ];

  const missing = extensionProviders(
    loaded?.environments ?? [],
    new Set(keys.map(({ provider }) => provider)),
  );

  return (
    <>
      <PageTitle description="Team work never uses anyone's own logins. Model calls go through the server, which swaps in the team's key, so runners never hold it. What can't go through it yet reaches the runner of every team Session.">
        Credentials
      </PageTitle>
      <Section
        title="Through the server"
        description="API keys on the Server base, set on Accounts"
      >
        {proxied.length === 0 ? (
          <p className="text-label text-fg-dim">
            No team key yet. Put an API key on the Server base from{" "}
            <a href="#settings/accounts" className="text-fg underline">
              Accounts
            </a>{" "}
            for team work to call models.
          </p>
        ) : (
          <Rows label="Through the server">
            {proxied.map(({ provider }) => (
              <Row
                key={provider}
                title={provider}
                initials={initialsOf(provider)}
                description="Each team Session gets a token of its own instead of the key."
              >
                <Badge state="done">Stays on the server</Badge>
              </Row>
            ))}
          </Rows>
        )}
      </Section>
      {reaching.length > 0 && (
        <Section
          title="Reach the runner"
          description="Secrets in team Profiles and Environments, and keys the server can't carry"
        >
          <Rows label="Reach the runner">
            {reaching.map(({ key, title, description }) => (
              <Row
                key={key}
                title={title}
                initials={initialsOf(title)}
                description={description}
              >
                <Badge state="waiting">Reaches the runner</Badge>
              </Row>
            ))}
          </Rows>
        </Section>
      )}
      {missing.length > 0 && (
        <Section
          title="No team key"
          description="Providers on team runners that team work can't call yet"
        >
          <Rows label="No team key">
            {missing.map(({ key, title, description }) => (
              <Row
                key={key}
                title={title}
                initials={initialsOf(title)}
                description={description}
              >
                <Badge state="offline">No key</Badge>
              </Row>
            ))}
          </Rows>
        </Section>
      )}
      <p className="mt-6 text-label text-fg-dim">
        Team work reaches git hosts, and installs its Profiles&apos; private
        packages, as the bot an admin chose for the team on each host, never
        with a person&apos;s token. Choose it under Bots in{" "}
        <a href="#team/setup/server/git-hosts" className="text-fg underline">
          Git hosts
        </a>
        .
      </p>
    </>
  );
}

// An MCP server's environment and headers go with it to the runner.
function mcpSecrets(
  owner: string,
  content: ProfileContent,
): readonly Reaching[] {
  return Object.entries(content.mcpServers).flatMap(([name, config]) => {
    const names = [
      ...Object.keys(fieldOf(config, "env")),
      ...Object.keys(fieldOf(config, "headers")),
    ];

    return names.length === 0
      ? []
      : [
          {
            key: `${owner}:${name}`,
            title: `${name} MCP server`,
            description: `${owner} · ${names.join(", ")}`,
          },
        ];
  });
}

function fieldOf(
  value: unknown,
  key: string,
): Readonly<Record<string, unknown>> {
  const inner =
    typeof value === "object" && value !== null
      ? (value as Readonly<Record<string, unknown>>)[key]
      : undefined;

  return typeof inner === "object" && inner !== null
    ? (inner as Readonly<Record<string, unknown>>)
    : {};
}

// Providers team runners list that the base has no key for, such as ones an
// extension adds.
function extensionProviders(
  environments: readonly Environment[],
  keyed: ReadonlySet<string>,
): readonly Reaching[] {
  const on = new Map<string, Set<string>>();

  for (const { name, models } of environments) {
    for (const { provider } of models) {
      if (!keyed.has(provider)) {
        on.set(provider, (on.get(provider) ?? new Set()).add(name));
      }
    }
  }

  return [...on].map(([provider, names]) => ({
    key: `provider:${provider}`,
    title: provider,
    description: `On the runners of ${[...names].join(", ")}. Put its key on the Server base from Accounts for team work to use it.`,
  }));
}
