import { randomBytes } from "node:crypto";
import {
  BadRequest,
  NotFound,
  readBody,
  type ServerPluginContext,
  Type,
} from "@pipoca/plugins";
import { HostRefused, loginOf } from "./github";
import type { HostStore } from "./hosts";
import type { TechnicalUserView } from "./model";
import { escaped, hash, originOf, page, redirect, secure } from "./pages";
import {
  appManifest,
  convertManifest,
  installationsOf,
  type TechnicalUser,
  type TechnicalUsers,
} from "./technical-users";

// An admin has this long to create the App on the host.
const attemptMs = 60 * 60_000;
const browserCookie = "pipoca-git-hosts-app";

interface Pending {
  readonly host: string;
  readonly hook: string;
  readonly browser: string;
  readonly expires: number;
}

const machineUser = Type.Object({
  name: Type.String(),
  host: Type.String(),
  token: Type.String(),
});

// Admins register technical users: GitHub Apps through GitHub's manifest
// flow, and machine users by their token (ADR 0060).
export function technicalUserRoutes(
  context: ServerPluginContext,
  hosts: HostStore,
  users: TechnicalUsers,
): {
  readonly manage: (
    request: Request,
    path: readonly string[],
  ) => Promise<Response>;
  readonly created: (request: Request) => Promise<Response>;
} {
  const pending = new Map<string, Pending>();

  const viewOf = async (user: TechnicalUser): Promise<TechnicalUserView> => {
    if (!("app" in user)) {
      return {
        name: user.name,
        host: user.host,
        kind: "token",
        login: user.login,
        installUrl: null,
        installedOn: null,
        error: null,
      };
    }

    const base = {
      name: user.name,
      host: user.host,
      kind: "app" as const,
      login: `${user.app.slug}[bot]`,
      installUrl: `${user.app.url}/installations/new`,
    };

    const host = hosts.get(user.host);

    if (host === undefined) {
      return { ...base, installedOn: [], error: `${user.host} isn't listed` };
    }

    try {
      const installations = await installationsOf(host, user.app);

      return {
        ...base,
        installedOn: installations.map(({ account }) => account),
        error: null,
      };
    } catch (failure) {
      if (!(failure instanceof HostRefused)) {
        throw failure;
      }

      return { ...base, installedOn: [], error: failure.message };
    }
  };

  // Sends the browser to the host with the App's manifest in a form, as the
  // manifest flow asks.
  const newApp = (request: Request): Response => {
    const params = new URL(request.url).searchParams;
    const host = hosts.get(params.get("host") ?? "");
    const name = params.get("name")?.trim() ?? "";
    const organization = params.get("organization")?.trim() ?? "";

    if (host === undefined) {
      return page("That host isn't listed.", 404);
    }

    if (name === "") {
      return page("Give the App a name.", 400);
    }

    if (organization !== "" && !/^[A-Za-z0-9-]+$/.test(organization)) {
      return page("That isn't an organization's name.", 400);
    }

    const now = Date.now();
    for (const [state, each] of pending) {
      if (each.expires < now) {
        pending.delete(state);
      }
    }

    const state = randomBytes(32).toString("base64url");
    const browser = randomBytes(32).toString("base64url");
    const hook = randomBytes(16).toString("hex");

    pending.set(state, {
      host: host.host,
      hook,
      browser: hash(browser),
      expires: now + attemptMs,
    });

    // The host sends events only to an address it can reach, which a server
    // on a laptop's http doesn't have.
    const manifest = appManifest(
      name,
      originOf(request),
      secure(request) ? hook : undefined,
    );

    const target = `https://${host.host}${organization === "" ? "" : `/organizations/${organization}`}/settings/apps/new?state=${state}`;

    return new Response(
      `<!doctype html><meta charset="utf-8"><title>Pipoca</title><form method="post" action="${escaped(target)}"><input type="hidden" name="manifest" value="${escaped(JSON.stringify(manifest))}"><p>Taking you to ${escaped(host.host)} to create the App…</p><button type="submit">Continue</button></form><script>document.forms[0].submit()</script>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          // Lax, since the host's redirect back is a cross-site navigation.
          "set-cookie": new Bun.Cookie(browserCookie, browser, {
            path: "/api/plugins/git-hosts/",
            httpOnly: true,
            sameSite: "lax",
            secure: secure(request),
            maxAge: attemptMs / 1000,
          }).serialize(),
        },
      },
    );
  };

  const created = async (request: Request): Promise<Response> => {
    const params = new URL(request.url).searchParams;
    const state = params.get("state") ?? "";
    const attempt = pending.get(state);
    const host = attempt && hosts.get(attempt.host);

    const browser = new Bun.CookieMap(request.headers.get("cookie") ?? "").get(
      browserCookie,
    );

    // The code must come back to the admin's browser that left with the
    // state, so a link can't plant someone else's App.
    if (
      attempt === undefined ||
      host === undefined ||
      attempt.expires < Date.now() ||
      browser === null ||
      hash(browser) !== attempt.browser
    ) {
      return page("This App's creation has expired. Start it again.", 400);
    }

    pending.delete(state);

    try {
      const app = await convertManifest(host, params.get("code") ?? "");

      users.add({
        name: app.slug,
        host: host.host,
        app: { ...app, hook: attempt.hook },
      });

      context.log("technical user added", {
        name: app.slug,
        host: host.host,
        kind: "app",
      });
    } catch (failure) {
      if (!(failure instanceof HostRefused || failure instanceof BadRequest)) {
        throw failure;
      }

      context.log("app creation failed", {
        host: host.host,
        error: failure.message,
      });

      return page(failure.message, 502);
    }

    return redirect("/#settings/git-hosts");
  };

  const manage = async (
    request: Request,
    path: readonly string[],
  ): Promise<Response> => {
    const [, name] = path;

    if (name === undefined && request.method === "GET") {
      return Response.json(await Promise.all(users.list().map(viewOf)));
    }

    if (name === "new-app" && request.method === "GET") {
      return newApp(request);
    }

    if (name === undefined && request.method === "POST") {
      const input = await readBody(request, machineUser);
      const host = hosts.get(input.host);

      if (host === undefined) {
        throw new BadRequest("that host isn't listed");
      }

      const token = input.token.trim();

      const login = await loginOf(host, token).catch((failure: unknown) => {
        throw failure instanceof HostRefused
          ? new BadRequest(failure.message)
          : failure;
      });

      users.add({ name: input.name.trim(), host: host.host, login, token });

      context.log("technical user added", {
        name: input.name.trim(),
        host: host.host,
        kind: "token",
      });

      return Response.json({ name: input.name.trim(), login }, { status: 201 });
    }

    if (name !== undefined && request.method === "DELETE") {
      if (!users.remove(name)) {
        throw new NotFound(`no technical user ${name}`);
      }

      context.log("technical user removed", { name });

      return Response.json({ removed: name });
    }

    throw new NotFound(`no route ${path.join("/")}`);
  };

  return { manage, created };
}
