import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type Clock, systemClock } from "@pipoca/protocol";
import type { CredentialStore } from "@pipoca/environments";
import type { PeopleStore } from "@pipoca/people";
import type { PluginStore, ServerPlugin } from "@pipoca/plugins";
import type { ProfileFolders, ProfileStore } from "@pipoca/profiles";
import type { SessionStore } from "@pipoca/sessions";
import { credentialStore } from "./credentials";
import { openDatabase, resetPlugin } from "./database";
import { peopleStore } from "./people";
import { pluginStore } from "./plugin-data";
import { kernelSchema } from "./schema";
import { fileSecretKey, SecretBox } from "./secret-box";
import { profileStore, sessionStore } from "./sessions";

export interface Store {
  readonly sessions: SessionStore;
  readonly profiles: ProfileStore;
  readonly people: PeopleStore;
  readonly credentials: CredentialStore;
  readonly plugin: (name: string) => PluginStore;
  // Why a plugin's tables can't be used, if they can't.
  readonly pluginFailure: (name: string) => string | undefined;
  // Drops a plugin's tables and makes them again, or says why it couldn't.
  readonly resetPlugin: (name: string) => string | undefined;
  readonly check: () => void;
  readonly close: () => void;
}

export function openStore(
  path: string,
  secretKey?: Buffer,
  profiles?: ProfileFolders,
  clock: Clock = systemClock,
  plugins: readonly Pick<ServerPlugin, "name" | "schema">[] = [],
): Store {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const box = new SecretBox(
    secretKey ??
      (path === ":memory:" ? randomBytes(32) : fileSecretKey(`${path}.key`)),
  );

  const { db, failures } = openDatabase(
    path,
    kernelSchema,
    plugins.flatMap(({ name, schema }) =>
      schema === undefined ? [] : [{ owner: name, sql: schema }],
    ),
    clock.now,
  );

  // A key that doesn't open what is sealed stops the start.
  const sealed = db
    .prepare(
      "select id, secrets_sealed from environments where secrets_sealed is not null limit 1",
    )
    .get() as { id: string; secrets_sealed: string } | undefined;

  if (sealed !== undefined) {
    box.open(sealed.secrets_sealed, sealed.id);
  }

  const selectAnySession = db.prepare("select 1 from sessions limit 1");
  const pluginStores = new Map<string, PluginStore>();

  return {
    sessions: sessionStore(db, clock, box, profiles),
    profiles: profileStore(db),
    people: peopleStore(db, clock),
    credentials: credentialStore(db, clock),
    plugin: (name) => {
      const failure = failures.get(name);

      if (failure !== undefined) {
        throw new Error(failure);
      }

      const found = pluginStores.get(name) ?? pluginStore(db, name, box);
      pluginStores.set(name, found);

      return found;
    },
    pluginFailure: (name) => failures.get(name),
    resetPlugin: (name) => {
      const declared = plugins.find((each) => each.name === name)?.schema;

      const failure =
        declared === undefined
          ? undefined
          : resetPlugin(db, { owner: name, sql: declared }, clock.now());

      if (failure === undefined) {
        failures.delete(name);
      } else {
        failures.set(name, failure);
      }

      return failure;
    },
    check: () => {
      selectAnySession.get();
    },
    close: () => {
      db.close();
    },
  };
}
