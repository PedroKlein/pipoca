import {
  BadRequest,
  defineServer,
  NotFound,
  type Owner,
  type Static,
  ToolError,
  Type,
} from "@pipoca/plugins";
import { slack } from "../plugin";
import type { BotView } from "./model";
import { botOf, call, SlackRefused } from "./slack";
import { type Connection, connect } from "./socket";

type Bot = Static<typeof slack.config>["bots"][number];

type Fields = Readonly<Record<string, unknown>>;

const newBot = Type.Object({
  name: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,62}$" }),
  appToken: Type.String({ minLength: 1 }),
  botToken: Type.String({ minLength: 1 }),
});

const post = Type.Object(
  {
    channel: Type.String({
      description: "The channel's id, such as C0123456, or its name",
    }),
    text: Type.String({ description: "Slack mrkdwn" }),
    thread_ts: Type.Optional(
      Type.String({
        description: "The thread to reply in, by its first message's ts",
      }),
    ),
    bot: Type.Optional(
      Type.String({
        description: "Which bot, when the user has more than one",
      }),
    ),
  },
  { additionalProperties: false },
);

const retryPrefix = "connect:";

// Slack messages as routine triggers, and Sessions that post as a bot, with
// replies in their threads coming back to them (ADR 0062).
export const server = defineServer(
  slack,
  ({
    config,
    events,
    log,
    routes,
    schedule,
    sessions,
    signal,
    tools,
    clock,
  }) => {
    const bots = config.collection("bots");

    const connections = new Map<
      string,
      { readonly key: string; readonly connection: Connection }
    >();

    const threadOf = (bot: string, channel: string, thread: string): string =>
      `${bot}:${channel}:${thread}`;

    // A reply in a thread a Session posted to goes to that Session, so the
    // thread works as a chat with it. Other messages are events.
    const heard = (name: string, event: Fields): void => {
      const bot = bots.get(name);

      if (bot === undefined) {
        return;
      }

      const type = text(event["type"]);
      const user = text(event["user"]);
      const channel = text(event["channel"]);
      const ts = text(event["ts"]);
      const threadTs = text(event["thread_ts"]);
      const ownOrBot = user === bot.botUser || event["bot_id"] !== undefined;

      if (ownOrBot || (type === "message" && event["subtype"] !== undefined)) {
        return;
      }

      const sessionId =
        threadTs === ""
          ? undefined
          : sessions.boundTo(threadOf(bot.name, channel, threadTs));

      if (
        sessionId !== undefined &&
        type === "message" &&
        sessions.send(sessionId, {
          text: `A reply in the Slack thread you posted to (channel ${channel}, thread ${threadTs}), from <@${user}>:\n\n${text(event["text"])}`,
          turn: true,
          notice: { kind: "slack_reply", data: { user } },
        }) === "queued"
      ) {
        return;
      }

      const base = { bot: bot.name, channel, user, ts };
      const to = { to: bot.users };

      if (type === "app_mention") {
        events.emit(
          "mention",
          { ...base, text: text(event["text"]), threadTs },
          to,
        );
      }

      if (type === "message") {
        events.emit(
          "message",
          {
            ...base,
            text: text(event["text"]),
            threadTs,
            channelType: text(event["channel_type"]),
          },
          to,
        );
      }

      if (type === "reaction_added") {
        const item = event["item"] as Fields | undefined;

        events.emit(
          "reaction",
          {
            ...base,
            channel: text(item?.["channel"]),
            ts: text(item?.["ts"]),
            reaction: text(event["reaction"]),
          },
          to,
        );
      }
    };

    const close = (name: string): void => {
      connections.get(name)?.connection.close();
      connections.delete(name);
      schedule.cancel(`${retryPrefix}${name}`);
    };

    // One connection per bot, opened again when its token or the API's
    // address changes, by Settings or by hand.
    const reconcile = (): void => {
      const { api } = config.get();
      const listed = bots.list();
      const keyOf = (bot: Bot): string => JSON.stringify([api, bot.appToken]);

      for (const [name, { key }] of connections) {
        const bot = listed.find((each) => each.name === name);

        if (bot === undefined || keyOf(bot) !== key) {
          close(name);
        }
      }

      for (const bot of listed.filter(({ name }) => !connections.has(name))) {
        const connection = connect(api, bot.appToken, {
          onEvent: (event) => {
            heard(bot.name, event);
          },
          retryIn: (ms) => {
            schedule.at(`${retryPrefix}${bot.name}`, clock.now() + ms);
          },
          log: (message, fields) => {
            log(message, { bot: bot.name, ...fields });
          },
        });

        connections.set(bot.name, { key: keyOf(bot), connection });
      }
    };

    schedule.on(retryPrefix, (_payload, key) => {
      connections.get(key.slice(retryPrefix.length))?.connection.reopen();
    });

    for (const { key } of schedule.pending(retryPrefix)) {
      schedule.cancel(key);
    }

    config.watch(reconcile);
    reconcile();

    signal.addEventListener("abort", () => {
      for (const { connection } of connections.values()) {
        connection.close();
      }
    });

    const usable = (owner: Owner): readonly Bot[] =>
      bots.list().filter((bot) => bot.users.includes(owner));

    tools.define({
      name: "slack_post",
      description:
        "Posts a message to Slack as one of the user's Slack bots, in a channel or as a reply in a thread. Replies people write in that thread come back to this Session as messages.",
      params: post,
      exposure: "direct",
      annotations: { readOnly: false, destructive: false },
      when: { available: (session) => usable(session.ownedBy).length > 0 },
      run: async (input, { session, owner }) => {
        const mine = usable(owner);

        const only = mine.length === 1 ? mine[0]?.name : undefined;
        const bot = mine.find(({ name }) => name === (input.bot ?? only));

        if (bot === undefined) {
          throw new ToolError(
            `name one of these bots: ${mine.map(({ name }) => name).join(", ")}`,
          );
        }

        const posted = await call(
          config.get().api,
          bot.botToken,
          "chat.postMessage",
          {
            channel: input.channel,
            text: input.text,
            ...(input.thread_ts !== undefined && {
              thread_ts: input.thread_ts,
            }),
          },
        ).catch((failure: unknown) => {
          throw failure instanceof SlackRefused
            ? new ToolError(failure.message)
            : failure;
        });

        const where = text(posted["channel"]) || input.channel;
        const ts = text(posted["ts"]);
        const threadTs = input.thread_ts ?? ts;

        sessions.bind(threadOf(bot.name, where, threadTs), session.id);

        return `Posted to ${where} as ${bot.name} (ts ${ts}). Replies in thread ${threadTs} come back here.`;
      },
    });

    const viewOf = (bot: Bot): BotView => ({
      name: bot.name,
      team: bot.team,
      botUser: bot.botUser,
      connected: connections.get(bot.name)?.connection.connected() ?? false,
      error: connections.get(bot.name)?.connection.error() ?? null,
    });

    routes.get("bots", { auth: "admin" }, () => bots.list().map(viewOf));

    routes.post(
      "bots",
      { auth: "admin", body: newBot, status: 201 },
      async ({ body, caller }) => {
        if (bots.get(body.name) !== undefined) {
          throw new BadRequest(`there is a bot ${body.name} already`);
        }

        const { team, userId } = await botOf(
          config.get().api,
          body.botToken.trim(),
        ).catch((failure: unknown) => {
          throw failure instanceof SlackRefused
            ? new BadRequest(failure.message)
            : failure;
        });

        bots.put({
          name: body.name,
          team,
          botUser: userId,
          appToken: body.appToken.trim(),
          botToken: body.botToken.trim(),
          users: [caller.owner],
        });

        log("slack bot added", { name: body.name, team });

        return { name: body.name, team };
      },
    );

    routes.delete("bots/:name", { auth: "admin" }, ({ params }) => {
      const { name } = params;

      if (!bots.remove(name)) {
        throw new NotFound(`no bot ${name}`);
      }

      log("slack bot removed", { name });

      return { removed: name };
    });
  },
);

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
