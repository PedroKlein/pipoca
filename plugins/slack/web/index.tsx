import {
  json,
  type NoticeProps,
  useLoaded,
  type WebContext,
  type WebPlugin,
} from "@pipoca/plugins/web";
import {
  Button,
  cardClass,
  cn,
  ErrorText,
  Field,
  fieldClass,
  useConfirm,
} from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import type { Account, BotView } from "../src/model";

// A Slack app with Socket Mode and the scopes the plugin's events and posts
// need, for Slack's "create from manifest".
const manifest = {
  display_information: { name: "Pipoca" },
  features: { bot_user: { display_name: "Pipoca", always_online: true } },
  oauth_config: {
    scopes: {
      bot: [
        "app_mentions:read",
        "channels:history",
        "groups:history",
        "im:history",
        "chat:write",
        "reactions:read",
      ],
    },
  },
  settings: {
    event_subscriptions: {
      bot_events: [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "reaction_added",
      ],
    },
    socket_mode_enabled: true,
  },
};

export const slack: WebPlugin = {
  name: "slack",
  SettingsSection,
  settingsGroup: "integrations",
  notices: { slack_reply: SlackReply },
};

function SettingsSection({
  context,
}: {
  readonly context: WebContext;
}): ReactElement | null {
  const { value: account } = useLoaded(
    async () => json<Account>(context.request("account")),
    "account",
  );

  if (account?.admin !== true) {
    return null;
  }

  return <Bots context={context} />;
}

function Bots({ context }: { readonly context: WebContext }): ReactElement {
  const [ask, asking] = useConfirm();
  const { value, reload } = useLoaded(
    async () => json<readonly BotView[]>(context.request("bots")),
    "bots",
  );

  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();

  const add = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const field = (name: string): string => {
      const entry = form.get(name);

      return typeof entry === "string" ? entry.trim() : "";
    };

    json(
      context.request("bots", {
        method: "POST",
        body: JSON.stringify({
          name: field("name"),
          appToken: field("appToken"),
          botToken: field("botToken"),
        }),
      }),
    ).then(
      () => {
        setAdding(false);
        setError(undefined);
        reload();
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  const remove = (bot: BotView): void => {
    void ask({
      title: `Remove ${bot.name}?`,
      description: `Routines stop hearing ${bot.name}, and Sessions can't post as it.`,
      confirm: "Remove",
      danger: true,
    }).then((yes) => {
      if (!yes) {
        return;
      }

      void json(
        context.request(`bots/${encodeURIComponent(bot.name)}`, {
          method: "DELETE",
        }),
      ).then(reload, reload);
    });
  };

  return (
    <div className="flex flex-col gap-2 text-ui">
      {asking}
      <p className="text-fg-dim">
        Bots whose messages, mentions and reactions become routine triggers, and
        that Sessions post as. They connect with Socket Mode, so Slack needs no
        address of this server.{" "}
        <a
          href={`https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`}
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline"
        >
          Create the Slack app
        </a>
        , install it to your workspace, and add an app-level token with
        connections:write.
      </p>
      <ul
        aria-label="Slack bots"
        className={cn(cardClass, "flex flex-col gap-1 p-3")}
      >
        {value?.length === 0 && <li className="text-fg-dim">No bots yet.</li>}
        {value?.map((bot) => (
          <li key={bot.name} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="flex-1 truncate text-fg">
                {bot.name}
                <span className="text-fg-dim">
                  {" "}
                  · {bot.team} · {bot.connected ? "connected" : "not connected"}
                </span>
              </span>
              <Button
                aria-label={`Remove ${bot.name}`}
                onClick={() => {
                  remove(bot);
                }}
              >
                Remove
              </Button>
            </div>
            {bot.error !== null && (
              <p className="text-caption text-failed">{bot.error}</p>
            )}
          </li>
        ))}
      </ul>
      {adding ? (
        <form
          onSubmit={add}
          aria-label="New Slack bot"
          className={cn(cardClass, "grid gap-4 p-5 md:grid-cols-2")}
        >
          <Field label="Name">
            <input
              name="name"
              required
              placeholder="team-bot"
              className={fieldClass}
            />
          </Field>
          <Field label="Bot token (xoxb-…)">
            <input
              name="botToken"
              type="password"
              autoComplete="off"
              required
              className={fieldClass}
            />
          </Field>
          <Field label="App-level token (xapp-…)">
            <input
              name="appToken"
              type="password"
              autoComplete="off"
              required
              className={fieldClass}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2 md:col-span-2">
            <Button variant="primary" type="submit">
              Add
            </Button>
            <Button
              onClick={() => {
                setAdding(false);
                setError(undefined);
              }}
            >
              Cancel
            </Button>
            <ErrorText size="caption">{error}</ErrorText>
          </div>
        </form>
      ) : (
        <div>
          <Button
            onClick={() => {
              setAdding(true);
            }}
          >
            Add a Slack bot
          </Button>
        </div>
      )}
    </div>
  );
}

function SlackReply({ text }: NoticeProps): ReactElement {
  return (
    <div className="flex flex-col gap-1 text-ui">
      <span className="text-label text-fg-dim">Reply in Slack</span>
      <span className="whitespace-pre-wrap text-fg">
        {text.split("\n\n").slice(1).join("\n\n")}
      </span>
    </div>
  );
}
