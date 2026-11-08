import type { Collection, ServerContext, Static } from "@pipoca/plugins";
import type { slack } from "../plugin";
import { call } from "./slack";

type Bot = Static<typeof slack.config>["bots"][number];

interface Posted {
  readonly question_id: string;
}

// A question goes back to the Slack thread its work came from, posted by the
// bot that heard it, and a reply there from a member of the channel answers
// it (ADR 0076).
export function questionReplies(
  {
    store,
    clock,
    config,
    provide,
    questions,
    log,
  }: Pick<
    ServerContext<typeof slack>,
    "store" | "clock" | "config" | "provide" | "questions" | "log"
  >,
  bots: Collection<Bot>,
): {
  readonly asked: (bot: string, channel: string, thread: string) => boolean;
  readonly answer: (
    bot: Bot,
    reply: {
      readonly channel: string;
      readonly thread: string;
      readonly user: string;
      readonly text: string;
    },
  ) => Promise<boolean>;
} {
  const posted = (
    bot: string,
    channel: string,
    thread: string,
  ): readonly Posted[] =>
    store.all<Posted>(
      "select question_id from slack_questions where bot = ? and channel = ? and thread_ts = ? order by posted_at",
      bot,
      channel,
      thread,
    );

  provide.replies({
    post: async ({ id, session, origin, text: asked }) => {
      const { fields } = origin;
      const bot = bots.get(String(fields["bot"]));
      const channel = text(fields["channel"]);
      const thread = text(fields["threadTs"]) || text(fields["ts"]);

      if (
        !origin.event.startsWith("slack.") ||
        bot === undefined ||
        !bot.users.includes(session.ownedBy) ||
        channel === "" ||
        thread === ""
      ) {
        return false;
      }

      await call(config.get().api, bot.botToken, "chat.postMessage", {
        channel,
        thread_ts: thread,
        text: `${asked.replaceAll("**", "*")}\n\nReply in this thread to answer.`,
      });

      store.run(
        "insert into slack_questions (question_id, bot, channel, thread_ts, posted_at) values (?, ?, ?, ?, ?)",
        id,
        bot.name,
        channel,
        thread,
        clock.now(),
      );

      return true;
    },
  });

  const member = async (
    bot: Bot,
    channel: string,
    user: string,
  ): Promise<boolean> => {
    let cursor = "";

    do {
      const page = await call(
        config.get().api,
        bot.botToken,
        "conversations.members",
        { channel, limit: 1000, ...(cursor !== "" && { cursor }) },
      );

      const members = Array.isArray(page["members"]) ? page["members"] : [];

      if (members.includes(user)) {
        return true;
      }

      const next = (
        page["response_metadata"] as
          { readonly next_cursor?: unknown } | undefined
      )?.next_cursor;

      cursor = typeof next === "string" ? next : "";
    } while (cursor !== "");

    return false;
  };

  return {
    asked: (bot, channel, thread) => posted(bot, channel, thread).length > 0,
    answer: async (bot, { channel, thread, user, text: said }) => {
      if (!(await member(bot, channel, user))) {
        return false;
      }

      for (const { question_id: id } of posted(bot.name, channel, thread)) {
        store.run("delete from slack_questions where question_id = ?", id);

        if (questions.answer(id, { text: said, by: `<@${user}>` })) {
          log("question answered in Slack", { id, channel });

          return true;
        }
      }

      return false;
    },
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
