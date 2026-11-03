import {
  BadRequest,
  isObject,
  type PluginConfig,
  type PluginStore,
} from "@pipoca/plugins";

// A Slack bot an admin added, a technical user like a GitHub App
// (ADR 0062).
export interface Bot {
  readonly name: string;
  readonly team: string;
  // The bot's own Slack user id, whose messages aren't events.
  readonly botUser: string;
  // Opens the Socket Mode connection.
  readonly appToken: string;
  // Posts and reads as the bot.
  readonly botToken: string;
  // The people whose routines hear it and whose Sessions post as it.
  readonly users: readonly string[];
}

export interface Bots {
  // The Web API's address, which only differs for tests and proxies.
  readonly api: () => string;
  readonly list: () => readonly Bot[];
  readonly add: (bot: Bot) => void;
  readonly remove: (name: string) => boolean;
}

const namePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

// Bots live under the plugin's key in pipoca.json, with their tokens sealed
// (ADR 0039). One that stops fitting is logged and left out.
export function botStore(
  config: PluginConfig,
  store: PluginStore,
  log: (message: string, fields?: Readonly<Record<string, unknown>>) => void,
): Bots {
  const sealedFor = (name: string): string => `slack bot ${name}`;

  const value = (): Readonly<Record<string, unknown>> => {
    const read = config.get();

    return isObject(read) ? read : {};
  };

  const items = (): readonly unknown[] => {
    const listed = value()["bots"];

    return Array.isArray(listed) ? listed : [];
  };

  const nameOf = (item: unknown): unknown =>
    isObject(item) ? item["name"] : undefined;

  return {
    api: () => {
      const api = value()["api"];

      return typeof api === "string"
        ? api.replace(/\/+$/, "")
        : "https://slack.com/api";
    },
    list: () =>
      items().flatMap((item, index) => {
        try {
          return [
            botOf(item, (sealed, name) => store.open(sealed, sealedFor(name))),
          ];
        } catch (failure) {
          log("a Slack bot in the config file doesn't fit", {
            index,
            error: failure instanceof Error ? failure.message : String(failure),
          });

          return [];
        }
      }),
    add: (bot) => {
      if (!namePattern.test(bot.name)) {
        throw new BadRequest(
          "a bot's name is lower-case letters, digits and dashes",
        );
      }

      if (items().some((item) => nameOf(item) === bot.name)) {
        throw new BadRequest(`there is a bot ${bot.name} already`);
      }

      config.set({
        ...value(),
        bots: [
          ...items(),
          {
            name: bot.name,
            team: bot.team,
            botUser: bot.botUser,
            appToken: store.seal(bot.appToken, sealedFor(bot.name)),
            botToken: store.seal(bot.botToken, sealedFor(bot.name)),
            users: bot.users,
          },
        ],
      });
    },
    remove: (name) => {
      const before = items();
      const after = before.filter((item) => nameOf(item) !== name);

      if (after.length === before.length) {
        return false;
      }

      config.set({ ...value(), bots: after });

      return true;
    },
  };
}

function botOf(
  item: unknown,
  open: (sealed: string, name: string) => string,
): Bot {
  if (!isObject(item)) {
    throw new BadRequest("must be an object");
  }

  const name = text(item["name"], "name");
  const { users = [] } = item;

  if (
    !Array.isArray(users) ||
    !users.every((each): each is string => typeof each === "string")
  ) {
    throw new BadRequest("users must be a list of user ids");
  }

  return {
    name,
    team: text(item["team"], "team"),
    botUser: text(item["botUser"], "botUser"),
    appToken: open(text(item["appToken"], "appToken"), name),
    botToken: open(text(item["botToken"], "botToken"), name),
    users,
  };
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new BadRequest(`${field} must be text`);
  }

  return value;
}
