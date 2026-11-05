import { HttpError } from "@pipoca/plugins";
import type { Invite, JoinInfo, JoinItem } from "@pipoca/protocol";
import type { Credentials, SignIn, User } from "@pipoca/people";
import type { ApiDeps, Group } from "../deps";
import { addressOf, type Handlers } from "../router";

export function authRoutes(deps: ApiDeps): Handlers<Group<"auth">> {
  const { people, signIn, plugins, team, log } = deps;

  return {
    "auth.status": ({ request }) => ({
      ...signIn.status(request),
      logins: plugins.logins(),
    }),
    "auth.setup": async ({
      request,
      body: { token, displayName, ...given },
    }) => {
      const user = await signIn.setUp(token, credentialsOf(given), displayName);

      if (user === undefined) {
        throw new HttpError(
          403,
          "This setup link is not the server's current one. Open the link from its latest log.",
          "invalid_token",
        );
      }

      log("first user created", { userId: user.id });

      return signedInAs(signIn, user, request, 201);
    },
    "auth.invite": ({ params: { token } }) => {
      const invite = people.inviteFor(token, undefined);

      if (invite === undefined) {
        throw expiredInvite();
      }

      return {
        email: invite.email,
        admin: invite.admin,
        invitedBy: people.userById(invite.createdBy)?.name ?? "An admin",
        team: team?.get().name ?? null,
        ...joining(deps, invite),
        expiresAt: invite.expiresAt,
        passwordLogin: signIn.passwordLogin,
        logins: plugins.logins().map((login) => ({
          ...login,
          path: `${login.path}?join=${token}`,
        })),
      } satisfies JoinInfo;
    },
    "auth.invite.accept": async ({ request, params: { token }, body }) => {
      const joined = await signIn.joinWithInvite(token, credentialsOf(body));

      if (joined === "off") {
        throw passwordLoginOff();
      }

      if (joined === "taken") {
        throw new HttpError(409, "Someone has that name.", "name_taken");
      }

      if (joined === undefined) {
        throw expiredInvite();
      }

      log("user joined", { userId: joined.id, admin: joined.admin });

      return signedInAs(signIn, joined, request, 201);
    },
    // Redeemed on GET, since it is a link a browser opens.
    "auth.link": ({ request, params: { token }, query: { verifier } }) => {
      const user = signIn.redeemLink(token, verifier);

      if (user === undefined) {
        throw new HttpError(
          403,
          "This sign-in link was used or is too old. Get a new one with pipoca link, or from the Pipoca app.",
          "invalid_token",
        );
      }

      log("signed in with a link", { userId: user.id });

      return new Response(null, {
        status: 303,
        headers: {
          location: "/",
          "set-cookie": signIn.startSession(user, request),
        },
      });
    },
    "auth.appLinks.create": ({ body: { challenge }, caller }) => {
      const user = people.userById(caller.id);

      if (user === undefined) {
        throw new HttpError(401, "Sign in first.", "signed_out");
      }

      if (!/^[\w-]{43}$/.test(challenge)) {
        throw new HttpError(
          400,
          "This isn't a link from the Pipoca app.",
          "invalid_challenge",
        );
      }

      log("signed the desktop app in", { userId: user.id });

      const link = new URL("pipoca://signed-in");
      link.searchParams.set("challenge", challenge);
      link.searchParams.set("link", signIn.appLink(user, challenge));

      return { link: link.href };
    },
    "auth.session.create": async ({ request, body }) => {
      const given = credentialsOf(body);
      const address = addressOf(request);
      const user = await signIn.signIn(given, address);

      if (user === "off") {
        throw passwordLoginOff();
      }

      if (user === "locked") {
        log("sign-in locked", { name: given.name, address });

        throw new HttpError(
          429,
          "Too many failed sign-ins. Try again in 15 minutes.",
          "locked",
        );
      }

      if (user === "wrong") {
        log("sign-in failed", { name: given.name, address });

        throw new HttpError(401, "Wrong name or password.", "wrong_password");
      }

      log("signed in", { userId: user.id });

      return signedInAs(signIn, user, request, 200);
    },
    "auth.session.remove": ({ request }) =>
      new Response(null, {
        status: 204,
        headers: { "set-cookie": signIn.endSession(request) },
      }),
  };
}

// What the team already set up for someone joining, and the setup steps
// left to them: an Environment from the template admins picked, the base
// Profile under theirs, the shared Profiles they pick from, and the steps
// admins made required.
function joining(
  { newcomers, templates, profiles, plugins }: ApiDeps,
  invite: Invite,
): Pick<JoinInfo, "setUp" | "yours"> {
  const chosen = newcomers?.get();
  const required = new Set(chosen?.required);

  const template = templates?.list().find(({ id }) => id === chosen?.template);

  const base = profiles.layer(invite.createdBy, "base");

  const baseParts = [
    ...(base.agentsMd === "" ? [] : ["instructions"]),
    ...(base.packages.length === 0
      ? []
      : [plural(base.packages.length, "package")]),
    ...Object.keys(base.mcpServers),
  ];

  const offered = (chosen?.profiles ?? []).flatMap(
    (id) => profiles.get(invite.createdBy, id)?.name ?? [],
  );

  const setUp: JoinItem[] = [
    ...(template === undefined
      ? []
      : [
          {
            title: template.name,
            summary: "You get your own Environment from it",
            optional: false,
          },
        ]),
    ...(baseParts.length === 0
      ? []
      : [
          {
            title: "Team base Profile",
            summary: sentence(baseParts.join(", ")),
            optional: false,
          },
        ]),
    ...(offered.length === 0
      ? []
      : [
          {
            title: "Profiles to pick from",
            summary: offered.join(", "),
            optional: false,
          },
        ]),
  ];

  const titles = new Map(plugins.list().map(({ id, title }) => [id, title]));

  const yours: JoinItem[] = [
    ...(template === undefined
      ? [
          {
            title: "Where Pi works",
            summary: "Your machine, Docker on it or a cluster",
            optional: false,
          },
        ]
      : []),
    ...[...required].flatMap((step) => {
      const title = titles.get(step);

      return title === undefined
        ? []
        : [{ title, summary: "Your team asks for it", optional: false }];
    }),
    {
      title: "Your Profile",
      summary:
        offered.length === 0
          ? "Your own skills on top of the team's"
          : "One of the team's, or your own",
      optional: !required.has("profile"),
    },
  ];

  return { setUp, yours };
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function signedInAs(
  signIn: SignIn,
  user: User,
  request: Request,
  status: number,
): Response {
  return Response.json(user, {
    status,
    headers: { "set-cookie": signIn.startSession(user, request) },
  });
}

function expiredInvite(): HttpError {
  return new HttpError(
    404,
    "This invite was used, revoked or is too old. Ask an admin for a new one.",
    "invalid_invite",
  );
}

function passwordLoginOff(): HttpError {
  return new HttpError(
    403,
    "This server doesn't sign people in with a password.",
    "password_login_off",
  );
}

function credentialsOf({ name, password }: Credentials): Credentials {
  return { name: name.trim(), password };
}
