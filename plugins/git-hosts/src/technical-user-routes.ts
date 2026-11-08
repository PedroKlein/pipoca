import { randomBytes } from "node:crypto";
import {
  BadRequest,
  type Collection,
  NotFound,
  owners,
  type ServerContext,
  Type,
} from "@pipoca/plugins";
import type { gitHosts, TechnicalUserItem } from "../plugin";
import { HostRefused, loginOf } from "./github";
import type { Hosts } from "./hosts";
import type { TechnicalUserView } from "./model";
import {
  backTo,
  escaped,
  html,
  page,
  redirect,
  then,
  type Then,
} from "./pages";
import {
  appManifest,
  botLogin,
  convertManifest,
  hearsWebhooks,
  installationsOf,
  isApp,
  type TechnicalUser,
} from "./technical-users";

// An admin has this long to create the App on the host.
const attemptMs = 60 * 60_000;

interface Pending {
  readonly host: string;
  readonly userId: string;
  readonly hook: string;
  readonly browser: string;
  readonly expires: number;
  readonly then: Then;
}

const namePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

const machineUser = Type.Object({
  name: Type.String(),
  host: Type.String(),
  token: Type.String(),
});

const newApp = Type.Object({
  host: Type.String(),
  name: Type.String(),
  organization: Type.Optional(Type.String()),
  then,
});

const teamChoice = Type.Object({ team: Type.Boolean() });

// Admins register technical users: GitHub Apps through GitHub's manifest
// flow, and machine users by their token (ADR 0060).
export function technicalUserRoutes(
  { routes, urls, clock, log }: ServerContext<typeof gitHosts>,
  hosts: Hosts,
  users: Collection<TechnicalUserItem>,
  added: () => void,
): void {
  const pending = new Map<string, Pending>();

  const add = (user: TechnicalUserItem): void => {
    if (!namePattern.test(user.name)) {
      throw new BadRequest(
        "a technical user's name is lower-case letters, digits and dashes",
      );
    }

    if (users.get(user.name) !== undefined) {
      throw new BadRequest(`there is a technical user ${user.name} already`);
    }

    users.put(user);
  };

  const viewOf = async (user: TechnicalUser): Promise<TechnicalUserView> => {
    const base = {
      name: user.name,
      host: user.host,
      login: botLogin(user),
      team: user.users.includes("team"),
    };

    if (!isApp(user)) {
      return {
        ...base,
        kind: "token",
        installUrl: null,
        installedOn: null,
        error: null,
      };
    }

    const app = {
      ...base,
      kind: "app" as const,
      installUrl: `${user.app.url}/installations/new`,
    };

    const host = hosts.get(user.host);

    if (host === undefined) {
      return { ...app, installedOn: [], error: `${user.host} isn't listed` };
    }

    try {
      const installations = await installationsOf(host, user.app, clock.now());

      return {
        ...app,
        installedOn: installations.map(({ account }) => account),
        error: null,
      };
    } catch (failure) {
      if (!(failure instanceof HostRefused)) {
        throw failure;
      }

      return { ...app, installedOn: [], error: failure.message };
    }
  };

  routes.get("technical-users", { auth: "admin" }, async () =>
    Promise.all(users.list().map(viewOf)),
  );

  // Sends the browser to the host with the App's manifest in a form, as the
  // manifest flow asks.
  routes.get(
    "technical-users/new-app",
    { auth: "admin", query: newApp },
    ({ caller, query }) => {
      const host = hosts.get(query.host);
      const name = query.name.trim();
      const organization = query.organization?.trim() ?? "";

      if (host === undefined) {
        return page("That host isn't listed.", 404);
      }

      if (name === "") {
        return page("Give the App a name.", 400);
      }

      if (organization !== "" && !/^[A-Za-z0-9-]+$/.test(organization)) {
        return page("That isn't an organization's name.", 400);
      }

      const now = clock.now();

      for (const [state, each] of pending) {
        if (each.expires < now) {
          pending.delete(state);
        }
      }

      const state = randomBytes(32).toString("base64url");
      const hook = randomBytes(16).toString("hex");

      const manifest = appManifest(
        name,
        urls,
        hearsWebhooks(urls) ? hook : undefined,
      );

      const target = `https://${host.host}${organization === "" ? "" : `/organizations/${organization}`}/settings/apps/new?state=${state}`;

      const response = html(
        `<title>Pipoca</title><form method="post" action="${escaped(target)}"><input type="hidden" name="manifest" value="${escaped(JSON.stringify(manifest))}"><p>Taking you to ${escaped(host.host)} to create the App…</p><button type="submit">Continue</button></form><script>document.forms[0].submit()</script>`,
        200,
      );

      pending.set(state, {
        host: host.host,
        userId: caller.person.id,
        hook,
        browser: urls.browser.mark(response, attemptMs),
        expires: now + attemptMs,
        then: query.then,
      });

      return response;
    },
  );

  routes.get(
    "app-created",
    {
      auth: "public",
      query: Type.Object({
        state: Type.Optional(Type.String()),
        code: Type.Optional(Type.String()),
      }),
    },
    async ({ query, raw }) => {
      const state = query.state ?? "";
      const attempt = pending.get(state);
      const host = attempt && hosts.get(attempt.host);

      // The code must come back to the admin's browser that left with the
      // state, so a link can't plant someone else's App.
      if (
        attempt === undefined ||
        host === undefined ||
        attempt.expires < clock.now() ||
        !urls.browser.is(raw, attempt.browser)
      ) {
        return page("This App's creation has expired. Start it again.", 400);
      }

      pending.delete(state);

      try {
        const app = await convertManifest(host, query.code ?? "");

        add({
          name: app.slug,
          host: host.host,
          users: [
            owners.of(attempt.userId),
            // Made in server setup for team work, unless the host has a
            // team bot already.
            ...(attempt.then === "server-setup" &&
            !users
              .list()
              .some(
                (each) =>
                  each.host === host.host && each.users.includes("team"),
              )
              ? (["team"] as const)
              : []),
          ],
          app: {
            id: app.id,
            slug: app.slug,
            url: app.url,
            privateKey: app.privateKey,
            ...(app.webhookSecret !== undefined && {
              webhookSecret: app.webhookSecret,
            }),
            hook: attempt.hook,
          },
        });

        added();

        log("technical user added", {
          name: app.slug,
          host: host.host,
          kind: "app",
        });
      } catch (failure) {
        if (!(
          failure instanceof HostRefused || failure instanceof BadRequest
        )) {
          throw failure;
        }

        log("app creation failed", {
          host: host.host,
          error: failure.message,
        });

        return page(failure.message, 502);
      }

      return redirect(backTo(attempt.then, "/#settings/git-hosts"));
    },
  );

  routes.post(
    "technical-users",
    { auth: "admin", body: machineUser, status: 201 },
    async ({ caller, body }) => {
      const host = hosts.get(body.host);

      if (host === undefined) {
        throw new BadRequest("that host isn't listed");
      }

      const name = body.name.trim();
      const token = body.token.trim();

      const login = await loginOf(host, token).catch((failure: unknown) => {
        throw failure instanceof HostRefused
          ? new BadRequest(failure.message)
          : failure;
      });

      add({
        name,
        host: host.host,
        users: [caller.owner],
        login,
        token,
      });

      log("technical user added", { name, host: host.host, kind: "token" });

      return { name, login };
    },
  );

  // Makes it the one team work signs in as on its host, or stops that.
  routes.patch(
    "technical-users/:name",
    { auth: "admin", body: teamChoice },
    ({ params, body: { team } }) => {
      const chosen = users.get(params.name);

      if (chosen === undefined) {
        throw new NotFound(`no technical user ${params.name}`);
      }

      for (const user of users.list()) {
        if (user.host !== chosen.host) {
          continue;
        }

        const others = user.users.filter((each) => each !== "team");

        const next =
          team && user.name === chosen.name
            ? [...others, "team" as const]
            : others;

        if (next.length !== user.users.length) {
          users.put({ ...user, users: next });
        }
      }

      log(
        team
          ? "team work signs in as technical user"
          : "team work stops signing in as technical user",
        { name: chosen.name },
      );

      return { name: chosen.name, team };
    },
  );

  routes.delete("technical-users/:name", { auth: "admin" }, ({ params }) => {
    if (!users.remove(params.name)) {
      throw new NotFound(`no technical user ${params.name}`);
    }

    log("technical user removed", { name: params.name });

    return { removed: params.name };
  });
}
