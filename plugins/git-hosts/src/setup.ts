import { type ServerContext, Type } from "@pipoca/plugins";
import type { gitHosts } from "../plugin";
import type { Hosts } from "./hosts";
import type { SetupState } from "./model";

const table = "git_hosts_setup_answers";

// Where the server and each person are in the plugin's setup steps
// (ADR 0072). The server's step is done once a host is listed or the admin
// goes on with none. A person's is done once they connected a listed host,
// or went on without one while the same hosts were listed, so a host added
// later brings the step back.
export function setupRoutes(
  { routes, store, config, clock }: ServerContext<typeof gitHosts>,
  hosts: Hosts,
  connectedOn: (userId: string) => readonly string[],
): void {
  const answer = (userId: string | null): readonly string[] | undefined => {
    const row = store.get<{ hosts: string }>(
      `select hosts from ${table} where coalesce(user_id, '') = ?`,
      userId ?? "",
    );

    return row === undefined
      ? undefined
      : (JSON.parse(row.hosts) as readonly string[]);
  };

  const answered = (userId: string | null, given: boolean): void => {
    store.transaction(() => {
      store.run(
        `delete from ${table} where coalesce(user_id, '') = ?`,
        userId ?? "",
      );

      if (given) {
        store.run(
          `insert into ${table} (user_id, hosts, answered_at) values (?, ?, ?)`,
          userId,
          JSON.stringify(userId === null ? [] : listed()),
          clock.now(),
        );
      }
    });
  };

  const listed = (): readonly string[] => hosts.list().map(({ host }) => host);

  const state = (userId: string): SetupState => {
    const names = listed();
    const own = answer(userId);
    const noHosts = answer(null) !== undefined;

    const withoutHosts =
      own !== undefined && names.every((host) => own.includes(host));

    const connected = connectedOn(userId).some((host) => names.includes(host));

    return {
      lockedIn: config.lockedIn() ?? null,
      noHosts,
      withoutHosts,
      server: names.length > 0 || noHosts,
      person: connected || withoutHosts,
    };
  };

  routes.get("setup", { auth: "person" }, ({ caller }) =>
    state(caller.person.id),
  );

  routes.put(
    "setup/server",
    {
      auth: "admin",
      body: Type.Object({ noHosts: Type.Boolean() }),
      changes: ["setup"],
    },
    ({ caller, body }) => {
      answered(null, body.noHosts);

      return state(caller.person.id);
    },
  );

  routes.put(
    "setup/person",
    {
      auth: "person",
      body: Type.Object({ withoutHosts: Type.Boolean() }),
      changes: ["setup"],
    },
    ({ caller, body }) => {
      answered(caller.person.id, body.withoutHosts);

      return state(caller.person.id);
    },
  );
}
