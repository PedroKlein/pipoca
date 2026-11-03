import {
  json,
  useLoaded,
  type WebContext,
  type WebPlugin,
} from "@pipoca/plugins/web";
import {
  Badge,
  Button,
  Icon,
  initialsOf,
  Row,
  Rows,
  Section,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import type { Account } from "../src/model";
import { ConnectForm, ConnectionCard } from "./connect";

export const logins: WebPlugin = {
  name: "logins",
  settingsParts: { Accounts },
};

const typeLabels = {
  oauth: "Signed in with your account",
  api_key: "API key",
} as const;

function Accounts({
  context,
}: {
  readonly context: WebContext;
}): ReactElement | null {
  const { value, reload } = useLoaded(
    async () => json<Account>(context.request("account")),
    "account",
    { topics: ["logins.logins"] },
  );

  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string>();

  if (value === undefined) {
    return null;
  }

  // The servers of the person's Profiles, and any other they signed in to
  // from a Session.
  const stored = new Set(value.mcp.map(({ server }) => server));

  const mcpServers = [
    ...new Set([...value.servers.map(({ key }) => key), ...stored]),
  ]
    .sort()
    .map((key) => ({ key, signedIn: stored.has(key) }));

  const send = (path: string, init: RequestInit): void => {
    json(context.request(path, init)).then(
      () => {
        setChoosing(false);
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
    <>
      <Section
        title="Providers"
        actions={
          value.connection === undefined &&
          !choosing && (
            <Button
              onClick={() => {
                setChoosing(true);
              }}
            >
              <Icon name="plus" />
              Add provider
            </Button>
          )
        }
      >
        {value.connection !== undefined && (
          <ConnectionCard connection={value.connection} send={send} />
        )}
        {value.connection === undefined && choosing && (
          <ConnectForm
            context={context}
            send={send}
            onClose={() => {
              setChoosing(false);
            }}
          />
        )}
        {error !== undefined && (
          <p role="alert" className="text-caption text-failed">
            {error}
          </p>
        )}
        <Rows label="Your model logins">
          {value.logins.length === 0 && (
            <Row
              title="No model provider yet"
              description="Add one here, or use /login in any Session."
            />
          )}
          {value.logins.map((login) => (
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
              description={typeLabels[login.type]}
            >
              <Button
                variant="ghost"
                aria-label={`Log out of ${login.provider}`}
                onClick={() => {
                  void json(
                    context.request(
                      `credentials/${encodeURIComponent(login.provider)}`,
                      { method: "DELETE" },
                    ),
                  ).then(reload, reload);
                }}
              >
                Log out
              </Button>
            </Row>
          ))}
        </Rows>
      </Section>
      <Section
        title="Tools"
        description="MCP servers in your Profiles that sign in"
      >
        <Rows label="Your MCP logins">
          {mcpServers.length === 0 && (
            <Row
              title="No MCP server signs in"
              description="None of your Profiles has an MCP server that needs a login."
            />
          )}
          {mcpServers.map(({ key, signedIn }) => {
            const [name = key, address = ""] = key.split(" ");

            return (
              <Row
                key={key}
                initials={initialsOf(name)}
                title={
                  <>
                    {name}
                    {signedIn && <Badge state="done">Signed in</Badge>}
                  </>
                }
                description={address}
              >
                {signedIn ? (
                  <Button
                    variant="ghost"
                    aria-label={`Log out of ${name}`}
                    onClick={() => {
                      send(`mcp/${encodeURIComponent(key)}`, {
                        method: "DELETE",
                      });
                    }}
                  >
                    Sign out
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    aria-label={`Sign in to ${name}`}
                    disabled={value.connection?.state === "running"}
                    onClick={() => {
                      send("connect-mcp", {
                        method: "POST",
                        body: JSON.stringify({ server: key }),
                      });
                    }}
                  >
                    Sign in
                  </Button>
                )}
              </Row>
            );
          })}
        </Rows>
      </Section>
    </>
  );
}
