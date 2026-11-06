import { Config, definePlugin } from "@pipoca/plugins";

export const push = definePlugin({
  id: "push",
  title: "Notifications",
  description:
    "Tells your devices when Pi finishes or needs you, even with Pipoca closed.",
  config: Config.object({
    answerMinutes: Config.number({
      title: "Minutes before a question goes to the starter",
      description:
        "In team work, how long a question Pi asks a named person waits before whoever started the work is told too.",
      default: 10,
      min: 1,
      max: 1440,
    }),
  }),
  // The server's one VAPID key, sealed, and each browser that subscribed.
  schema: `
create table push_vapid (
  id integer primary key check (id = 1),
  private_key text not null
) strict;

create table push_subscriptions (
  endpoint text primary key,
  user_id text not null references users (id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at integer not null
) strict, without rowid;
create index push_subscriptions_user on push_subscriptions (user_id);
`,
});
