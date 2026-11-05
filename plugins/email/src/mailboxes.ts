import type { Log } from "@pipoca/protocol";
import {
  BadRequest,
  isObject,
  type PluginConfig,
  type PluginStore,
  secretRefs,
} from "@pipoca/plugins";

export interface Server {
  readonly host: string;
  readonly port: number;
  // TLS from the start, as on ports 993 and 465. Otherwise the connection
  // upgrades with STARTTLS when the server offers it.
  readonly secure: boolean;
}

// A mailbox an admin added, a technical user like a Slack bot (ADR 0062).
export interface Mailbox {
  readonly name: string;
  // Who its mail is from.
  readonly address: string;
  readonly user: string;
  readonly password: string;
  readonly imap: Server;
  readonly smtp: Server;
  // The people whose routines hear its mail and whose Sessions send from it.
  readonly users: readonly string[];
}

export interface Mailboxes {
  readonly list: () => readonly Mailbox[];
  readonly add: (mailbox: Mailbox) => void;
  readonly remove: (name: string) => boolean;
}

const namePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

// Mailboxes live under the plugin's key in pipoca.json, with their passwords
// sealed or named by environment variable (ADR 0039). One that stops fitting
// is logged and left out.
export function mailboxStore(
  config: PluginConfig,
  store: PluginStore,
  log: Log,
): Mailboxes {
  const sealedFor = (name: string): string => `email mailbox ${name}`;
  const refs = secretRefs(store);

  const value = (): Readonly<Record<string, unknown>> => {
    const read = config.get();

    return isObject(read) ? read : {};
  };

  const items = (): readonly unknown[] => {
    const listed = value()["mailboxes"];

    return Array.isArray(listed) ? listed : [];
  };

  const nameOf = (item: unknown): unknown =>
    isObject(item) ? item["name"] : undefined;

  return {
    list: () =>
      items().flatMap((item, index) => {
        try {
          return [
            mailboxOf(
              item,
              (ref, name) => refs.open(ref, sealedFor(name), "password").secret,
            ),
          ];
        } catch (failure) {
          log("a mailbox in the config file doesn't fit", {
            index,
            error: failure instanceof Error ? failure.message : String(failure),
          });

          return [];
        }
      }),
    add: (mailbox) => {
      if (!namePattern.test(mailbox.name)) {
        throw new BadRequest(
          "a mailbox's name is lower-case letters, digits and dashes",
        );
      }

      if (items().some((item) => nameOf(item) === mailbox.name)) {
        throw new BadRequest(`there is a mailbox ${mailbox.name} already`);
      }

      config.set({
        ...value(),
        mailboxes: [
          ...items(),
          {
            ...mailbox,
            password: refs.seal(mailbox.password, sealedFor(mailbox.name)),
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

      config.set({ ...value(), mailboxes: after });

      return true;
    },
  };
}

function mailboxOf(
  item: unknown,
  open: (value: unknown, name: string) => string,
): Mailbox {
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
    address: text(item["address"], "address"),
    user: text(item["user"], "user"),
    password: open(item["password"], name),
    imap: serverOf(item["imap"], "imap"),
    smtp: serverOf(item["smtp"], "smtp"),
    users,
  };
}

function serverOf(value: unknown, field: string): Server {
  if (
    !isObject(value) ||
    typeof value["port"] !== "number" ||
    typeof value["secure"] !== "boolean"
  ) {
    throw new BadRequest(`${field} must hold a host, port and secure`);
  }

  return {
    host: text(value["host"], `${field}.host`),
    port: value["port"],
    secure: value["secure"],
  };
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new BadRequest(`${field} must be text`);
  }

  return value;
}
