import {
  BadRequest,
  NotFound,
  readBody,
  requireAdmin,
  type ServerPlugin,
  Type,
} from "@pipoca/plugins";
import { type Bot, botStore } from "./bots";
import type { Account, BotView } from "./model";
import { botOf, call, SlackRefused } from "./slack";
import { type Connection, connect } from "./socket";

type Fields = Readonly<Record<string, unknown>>;

const newBot = Type.Object({
  name: Type.String(),
  appToken: Type.String(),
  botToken: Type.String(),
});

// Slack messages as routine triggers, and Sessions that post as a bot, with
// replies in their threads coming back to them (ADR 0062).
export const slack: ServerPlugin = {
  name: "slack",
  register: (context) => {
    const bots = botStore(context.config, context.store, context.log);
    const connections = new Map<string, Connection>();

    context.store.exec(
      `create table if not exists slack_threads (bot text not null, channel text not null, thread_ts text not null, session_id text not null, primary key (bot, channel, thread_ts))`,
    );

    const sessionOfThread = (
      bot: string,
      channel: string,
      thread: string,
    ): string | undefined =>
      (
        context.store.all(
          "select session_id from slack_threads where bot = ? and channel = ? and thread_ts = ?",
          bot,
          channel,
          thread,
        ) as { session_id: string }[]
      )[0]?.session_id;

    // A reply in a thread a Session posted to goes to that Session, so the
    // thread works as a chat with it. Other messages are events.
    const heard = (bot: Bot, event: Fields): void => {
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
          : sessionOfThread(bot.name, channel, threadTs);

      if (sessionId !== undefined && type === "message") {
        const sent = context.sessions.send(
          sessionId,
          `A reply in the Slack thread you posted to (channel ${channel}, thread ${threadTs}), from <@${user}>:\n\n${text(event["text"])}`,
          "plugin:slack",
          { kind: "slack_reply", data: { user } },
        );

        if (sent.ok) {
          return;
        }
      }

      const base = { bot: bot.name, channel, user, ts, userIds: bot.users };

      switch (type) {
        case "app_mention":
          context.events.publish({
            type: "slack.mention",
            ...base,
            text: text(event["text"]),
            threadTs,
          });

          return;
        case "message":
          context.events.publish({
            type: "slack.message",
            ...base,
            text: text(event["text"]),
            threadTs,
            channelType: text(event["channel_type"]),
          });

          return;
        case "reaction_added": {
          const item = event["item"] as Fields | undefined;

          context.events.publish({
            type: "slack.reaction",
            ...base,
            channel: text(item?.["channel"]),
            ts: text(item?.["ts"]),
            reaction: text(event["reaction"]),
          });

          return;
        }

        default:
      }
    };

    const reconcile = (): void => {
      const listed = bots.list();

      for (const [name, connection] of connections) {
        if (!listed.some((bot) => bot.name === name)) {
          connection.close();
          connections.delete(name);
        }
      }

      for (const bot of listed) {
        if (!connections.has(bot.name)) {
          connections.set(
            bot.name,
            connect(
              bots.api(),
              bot.appToken,
              (event) => {
                heard(bot, event);
              },
              (message, fields) => {
                context.log(message, { bot: bot.name, ...fields });
              },
            ),
          );
        }
      }
    };

    reconcile();

    context.signal.addEventListener("abort", () => {
      for (const connection of connections.values()) {
        connection.close();
      }
    });

    const usable = (userId: string | null): readonly Bot[] =>
      userId === null
        ? []
        : bots.list().filter((bot) => bot.users.includes(userId));

    context.tools.register({
      name: "slack_post",
      description:
        "Posts a message to Slack as one of the user's Slack bots, in a channel or as a reply in a thread. Replies people write in that thread come back to this Session as messages.",
      parameters: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description: "The channel's id, such as C0123456, or its name",
          },
          text: { type: "string", description: "Slack mrkdwn" },
          thread_ts: {
            type: "string",
            description: "The thread to reply in, by its first message's ts",
          },
          bot: {
            type: "string",
            description: "Which bot, when the user has more than one",
          },
        },
        required: ["channel", "text"],
        additionalProperties: false,
      },
      exposure: "direct",
      annotations: { readOnlyHint: false, destructiveHint: false },
      appliesTo: (session) => usable(session.startedBy).length > 0,
      run: async (input, { session }) => {
        const {
          channel,
          text: message,
          thread_ts: thread,
          bot: name,
        } = input as Record<string, unknown>;

        const mine = usable(session.startedBy);
        const only = mine.length === 1 ? mine[0] : undefined;

        const bot =
          typeof name === "string"
            ? mine.find((each) => each.name === name)
            : only;

        if (bot === undefined) {
          return {
            text: `name one of these bots: ${mine.map((each) => each.name).join(", ")}`,
            isError: true,
          };
        }

        if (typeof channel !== "string" || typeof message !== "string") {
          return { text: "give a channel and the text", isError: true };
        }

        try {
          const posted = await call(
            bots.api(),
            bot.botToken,
            "chat.postMessage",
            {
              channel,
              text: message,
              ...(typeof thread === "string" && { thread_ts: thread }),
            },
          );

          const where = text(posted["channel"]) || channel;
          const ts = text(posted["ts"]);
          const threadTs = typeof thread === "string" ? thread : ts;

          context.store.run(
            "insert into slack_threads (bot, channel, thread_ts, session_id) values (?, ?, ?, ?) on conflict do update set session_id = excluded.session_id",
            bot.name,
            where,
            threadTs,
            session.id,
          );

          return {
            text: `Posted to ${where} as ${bot.name} (ts ${ts}). Replies in thread ${threadTs} come back here.`,
            isError: false,
          };
        } catch (failure) {
          if (!(failure instanceof SlackRefused)) {
            throw failure;
          }

          return { text: failure.message, isError: true };
        }
      },
    });

    const viewOf = (bot: Bot): BotView => ({
      name: bot.name,
      team: bot.team,
      botUser: bot.botUser,
      connected: connections.get(bot.name)?.connected() ?? false,
      error: connections.get(bot.name)?.error() ?? null,
    });

    context.routes.handle(async (request, path, caller) => {
      const [route, name] = path.split("/");

      if (route === "account" && request.method === "GET") {
        const account: Account = {
          admin: caller.kind === "user" && caller.admin,
        };

        return Response.json(account);
      }

      if (route !== "bots") {
        throw new NotFound(`no route ${path}`);
      }

      requireAdmin(caller, "Only admins manage Slack bots.");

      if (name === undefined && request.method === "GET") {
        return Response.json(bots.list().map(viewOf));
      }

      if (name === undefined && request.method === "POST") {
        const input = await readBody(request, newBot);

        const { team, userId } = await botOf(
          bots.api(),
          input.botToken.trim(),
        ).catch((failure: unknown) => {
          throw failure instanceof SlackRefused
            ? new BadRequest(failure.message)
            : failure;
        });

        bots.add({
          name: input.name.trim(),
          team,
          botUser: userId,
          appToken: input.appToken.trim(),
          botToken: input.botToken.trim(),
          users:
            caller.kind === "user" ? [caller.actor.slice("user:".length)] : [],
        });

        reconcile();
        context.log("slack bot added", { name: input.name.trim(), team });

        return Response.json(
          { name: input.name.trim(), team },
          { status: 201 },
        );
      }

      if (name !== undefined && request.method === "DELETE") {
        if (!bots.remove(name)) {
          throw new NotFound(`no bot ${name}`);
        }

        reconcile();
        context.log("slack bot removed", { name });

        return Response.json({ removed: name });
      }

      throw new NotFound(`no route ${path}`);
    });
  },
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
