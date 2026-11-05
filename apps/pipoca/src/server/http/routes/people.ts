import { HttpError, NotFound } from "@pipoca/plugins";
import type { Teammate } from "@pipoca/protocol";
import type { AccessToken } from "@pipoca/people";
import type { ApiDeps, Group } from "../deps";
import type { Handlers } from "../router";

export function peopleRoutes({
  people,
  plugins,
  log,
}: ApiDeps): Handlers<Group<"people"> | Group<"invites">> {
  return {
    // Everyone names people in team work; admins also see their roles and
    // when they were last active.
    "people.list": ({ caller }) =>
      caller.admin
        ? people.people()
        : people.users().map(({ id, name }): Teammate => ({ id, name })),
    "people.update": ({ params: { id }, body: { admin } }) => {
      const changed = people.changeRole(id, admin);

      if (changed === "not_found") {
        throw new NotFound("Not found.");
      }

      if (changed === "last_admin") {
        throw new HttpError(
          409,
          "The server needs an admin: make someone else an admin first.",
          "last_admin",
        );
      }

      log("role changed", { userId: id, admin });

      return changed;
    },
    "invites.list": () => people.invites(),
    "invites.create": ({ request, body, caller }) => {
      const { emails = [], admin = false, days = 7 } = body;
      const made = people.invite(caller.id, emails, admin, days);
      const name = people.userById(caller.id)?.name ?? "An admin";

      for (const invite of made) {
        if (invite.email !== null) {
          plugins.publish({
            type: "PersonInvited",
            email: invite.email,
            link: `${originOf(request)}/#join/${invite.token}`,
            invitedBy: { id: caller.id, name },
            admin: invite.admin,
            expiresAt: invite.expiresAt,
          });
        }
      }

      log("people invited", {
        invites: made.length,
        link: made.some((invite) => invite.email === null),
        admin,
      });

      return made;
    },
    "invites.remove": ({ params: { id } }) => {
      if (!people.revokeInvite(id)) {
        throw new NotFound("Not found.");
      }

      return undefined;
    },
  };
}

export function meRoutes({
  people,
  log,
}: ApiDeps): Handlers<Exclude<Group<"me">, Group<"me.profileDefaults">>> {
  return {
    "me.setup": ({ caller }) => people.setup(caller.id),
    "me.setup.update": ({ body, caller }) => {
      if ("finished" in body) {
        people.finishSetup(caller.id);
      } else {
        people.dismissSetupStep(caller.id, body.dismiss);
      }

      return people.setup(caller.id);
    },
    "me.pinnedPages": ({ caller }) => ({
      pages: people.pinnedPages(caller.id),
    }),
    "me.pinnedPages.update": ({ body: { pages }, caller }) => {
      people.pinPages(caller.id, pages);

      return { pages: people.pinnedPages(caller.id) };
    },
    "me.accessTokens": ({ caller }) =>
      people.accessTokens(caller.id).map(tokenView),
    "me.accessTokens.create": ({ body: { name }, caller }) => {
      const { token, secret } = people.newAccessToken(caller.id, name);
      log("access token created", { tokenId: token.id });

      return { ...tokenView(token), secret };
    },
    "me.accessTokens.remove": ({ params: { id }, caller }) => {
      if (!people.revokeAccessToken(caller.id, id)) {
        throw new NotFound("Not found.");
      }

      log("access token revoked", { tokenId: id });

      return undefined;
    },
  };
}

function tokenView({
  id,
  name,
  createdAt,
}: AccessToken): Omit<AccessToken, "userId"> {
  return { id, name, createdAt };
}

// The Host header already passed the server's own site check, and HTTPS
// usually ends in a gateway in front of the server (ADR 0034).
function originOf(request: Request): string {
  const url = new URL(request.url);

  const secure =
    url.protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https";

  return `${secure ? "https" : "http"}://${request.headers.get("host") ?? url.host}`;
}
