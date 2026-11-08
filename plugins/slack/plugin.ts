import { Config, event, definePlugin, Secret, Type } from "@pipoca/plugins";

const bot = Type.Object({
  name: Type.String({ title: "Name" }),
  team: Type.String({ title: "Workspace", minLength: 1 }),
  botUser: Type.String({ title: "Bot user", minLength: 1 }),
  appToken: Secret({ title: "App-level token", env: true }),
  botToken: Secret({ title: "Bot token", env: true }),
  users: Config.audience(),
});

const heard = {
  bot: Type.String({ description: "The Slack bot that heard it" }),
  channel: Type.String({ description: "The channel's id" }),
  user: Type.String({ description: "Who wrote or reacted, by Slack user id" }),
  ts: Type.String({
    description: "The message's timestamp, its id in the channel",
  }),
};

export const slack = definePlugin({
  id: "slack",
  title: "Slack",
  description:
    "Turns messages, mentions and reactions in Slack into routine triggers, and lets Sessions post and reply in threads as a bot. Admins add bots in Settings.",
  config: Config.object({
    api: Config.string({
      title: "Web API",
      default: "https://slack.com/api",
      hidden: true,
    }),
    bots: Config.collection({
      title: "Bots",
      key: "name",
      admin: true,
      item: bot,
    }),
  }),
  // Questions posted in the thread their work came from (ADR 0076).
  schema: `
create table slack_questions (
  question_id text primary key,
  bot text not null,
  channel text not null,
  thread_ts text not null,
  posted_at integer not null
) strict;
create index slack_questions_thread on slack_questions (bot, channel, thread_ts);
`,
  events: {
    mention: event({
      title: "Slack mention",
      description: "Someone mentioned the bot in a channel it is in.",
      fields: Type.Object({
        ...heard,
        text: Type.String(),
        threadTs: Type.String({
          description: "The thread it is in, empty when it isn't",
        }),
      }),
    }),
    message: event({
      title: "Slack message",
      description:
        "A message in a channel the bot is in, or sent to the bot directly.",
      fields: Type.Object({
        ...heard,
        text: Type.String(),
        threadTs: Type.String(),
        channelType: Type.String({ description: "channel, group or im" }),
      }),
    }),
    reaction: event({
      title: "Slack reaction",
      description:
        "Someone added a reaction to a message in a channel the bot is in.",
      fields: Type.Object({
        ...heard,
        reaction: Type.String({
          description: "The emoji's name, such as eyes",
        }),
      }),
    }),
  },
});
