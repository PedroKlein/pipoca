import { json, useLoaded, type WebContext } from "@pipoca/plugins/web";
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
export function TeamCredentials({
  context,
}: {
  readonly context: WebContext;
}): ReactElement {
  const { value: keys = [] } = useLoaded(
    async () => json<readonly TeamKey[]>(context.request("team-keys")),
    "team-keys",
    { topics: ["logins.logins"] },
  );

  const { value: reaching = [] } = useLoaded(
    async () => {
      const [profiles, base, environments] = await Promise.all([
        json<readonly Profile[]>(context.request("/api/profiles?owner=team")),
        json<ProfileContent>(context.request("/api/base")),
        json<readonly Environment[]>(
          context.request("/api/environments?owner=team"),
        ),
      ]);

      return [
        ...mcpSecrets("Server base", base),
        ...profiles.flatMap((profile) => mcpSecrets(profile.name, profile)),
        ...environments
          .filter(({ secrets }) => secrets.length > 0)
          .map(({ id, name, secrets }) => ({
            key: `environment:${id}`,
            title: name,
            description: `Environment secrets ${secrets.join(", ")}`,
          })),
      ];
    },
    "reaching",
    { topics: ["profiles", "environments"] },
  );

  const proxied = keys.filter(({ proxied: through }) => through);
  const unused = keys.filter(({ proxied: through }) => !through);

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
          description="Secrets in team Profiles and Environments"
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
      {unused.length > 0 && (
        <Section
          title="Not used by team work"
          description="The server can't pass these on for team work"
        >
          <Rows label="Not used by team work">
            {unused.map(({ provider }) => (
              <Row
                key={provider}
                title={provider}
                initials={initialsOf(provider)}
                description="A provider an extension adds signs in where the extension runs. Team work gets no copy of this key."
              >
                <Badge state="offline">Personal work only</Badge>
              </Row>
            ))}
          </Rows>
        </Section>
      )}
      <p className="mt-6 text-label text-fg-dim">
        Team work reaches git hosts as a technical user whose people include the
        team, never with a person&apos;s token. Set those up in{" "}
        <a href="#settings/git-hosts" className="text-fg underline">
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
