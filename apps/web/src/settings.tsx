import {
  Button,
  Command,
  ErrorText,
  Page,
  Row,
  Rows,
  TextInput,
  useConfirm,
} from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { api } from "./api";
import { useAccessTokens } from "./hooks";

export function SettingsPage(): ReactElement {
  const { value: tokens, reload } = useAccessTokens();

  // A token shows once, right after it is made, like an Environment's key.
  const [made, setMade] = useState<{
    readonly name: string;
    readonly secret: string;
  }>();

  const [error, setError] = useState<string>();
  const [ask, asking] = useConfirm();

  const revoke = async (id: string, name: string): Promise<void> => {
    const yes = await ask({
      title: `Revoke ${name}'s token?`,
      description: `${name} won't be able to reach Pipoca any more.`,
      confirm: "Revoke",
      danger: true,
    });

    if (!yes) {
      return;
    }

    api("me.accessTokens.remove", { params: { id } }).then(
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
    <Page
      id="settings-page"
      title="Access tokens"
      description="An MCP client, such as Pi or Claude Code on your laptop, can use the assistant's tools to manage Sessions, Environments, Profiles and Projects as you. It asks for a token, and you can revoke one at any time."
    >
      <div className="flex flex-col gap-3">
        <NewToken
          onCreated={(name, secret) => {
            setMade({ name, secret });
            reload();
          }}
        />
        {made && (
          <div className="flex flex-col gap-2 text-ui">
            <p className="text-fg-dim">
              Add the server to your client with this token. It is shown only
              now.
            </p>
            <Command label="Add command">
              {`claude mcp add --transport http pipoca ${location.origin}/api/mcp --header "Authorization: Bearer ${made.secret}"`}
            </Command>
          </div>
        )}
        <Rows label="MCP tokens">
          {tokens.length === 0 && (
            <li className="px-4 py-3.5 text-ui text-fg-dim">
              No client has a token.
            </li>
          )}
          {tokens.map((token) => (
            <Row
              key={token.id}
              title={token.name}
              description={`Made ${new Date(token.createdAt).toLocaleDateString()}`}
            >
              <Button
                size="sm"
                aria-label={`Revoke ${token.name}`}
                onClick={() => {
                  void revoke(token.id, token.name);
                }}
              >
                Revoke
              </Button>
            </Row>
          ))}
        </Rows>
        <ErrorText size="caption">{error}</ErrorText>
      </div>
      {asking}
    </Page>
  );
}

function NewToken({
  onCreated,
}: {
  readonly onCreated: (name: string, secret: string) => void;
}): ReactElement {
  const [error, setError] = useState<string>();

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = new FormData(form).get("name");

    void api("me.accessTokens.create", {
      body: { name: typeof name === "string" ? name : "" },
    })
      .then((created) => {
        setError(undefined);
        form.reset();
        onCreated(created.name, created.secret);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  };

  return (
    <form
      onSubmit={submit}
      aria-label="New MCP token"
      className="flex flex-wrap items-center gap-2"
    >
      <TextInput
        name="name"
        required
        aria-label="Client name"
        placeholder="My laptop"
        className="w-48"
      />
      <Button type="submit">New token</Button>
      <ErrorText size="caption">{error}</ErrorText>
    </form>
  );
}
