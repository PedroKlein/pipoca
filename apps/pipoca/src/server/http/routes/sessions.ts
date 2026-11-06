import { BadRequest, HttpError, NotFound } from "@pipoca/plugins";
import { checkBody } from "@pipoca/plugins/host";
import {
  type ForkedSession,
  type ForkSession,
  forkSession,
  type MoveToTeam,
  moveToTeam,
  type Session,
  type SessionAccess,
  type SessionEvent,
  sseResponse,
} from "@pipoca/protocol";
import { canManage, canSee, canSteer, type Viewer } from "@pipoca/people";
import { presences } from "../../../presence";
import type { ApiDeps, Group } from "../deps";
import { ok, rejection } from "../replies";
import type { Handlers, PersonCaller } from "../router";

// A person reaches only their own Sessions and the team's they may see. An
// admin also reaches everyone's outline, and stops, archives or deletes them
// (ADR 0049).
export function sessionRoutes({
  sessions,
  people,
  plugins,
  log,
}: ApiDeps): Handlers<Group<"sessions">> {
  const present = presences();

  // Sessions decide only for people; an admin's rights come from the route.
  const seen = (id: string, caller: PersonCaller): void => {
    if (!canSee(viewerOf(caller, false), sessions.owned(id))) {
      throw new NotFound("Not found.");
    }
  };

  const steered = (id: string, caller: PersonCaller): void => {
    const owned = sessions.owned(id);
    const viewer = viewerOf(caller, caller.admin);

    if (!canManage(viewer, owned)) {
      throw canSee(viewer, owned)
        ? rejection("view_only")
        : new NotFound("Not found.");
    }
  };

  const forked = (body: ForkSession, caller: PersonCaller): ForkedSession => {
    const { from, personal, ...fork } = body;

    seen(from.session, caller);

    const made = ok(
      sessions.fork(from.session, {
        ...fork,
        ...(from.entry !== undefined && { entry: from.entry }),
        ...(personal === true && { personal }),
        actor: caller.actor,
      }),
    );

    log("session forked", {
      sessionId: made.id,
      from: from.session,
      environmentId: made.environmentId,
      fromMessage: made.editorText !== undefined,
    });

    return made;
  };

  const moved = (body: MoveToTeam, caller: PersonCaller): Session => {
    const { from, owner: _team, summary, ...move } = body;

    seen(from.session, caller);

    const made = ok(
      sessions.move(from.session, {
        ...move,
        summary: summary.trim(),
        actor: caller.actor,
      }),
    );

    log("session moved to the team", {
      sessionId: made.id,
      from: from.session,
      environmentId: made.environmentId,
    });

    return made;
  };

  const limit = (
    id: string,
    change: SessionAccess,
    caller: PersonCaller,
  ): void => {
    const access =
      change.kind === "named"
        ? { kind: change.kind, people: [...new Set(change.people)] }
        : change;

    const users = new Set(people.users().map((user) => user.id));

    if (
      access.kind === "named" &&
      !access.people.every((person) => users.has(person))
    ) {
      throw new BadRequest("people must be users of this server");
    }

    ok(sessions.limit(id, access, { person: caller.id, admin: caller.admin }));
    log("session access changed", { sessionId: id, access: access.kind });
  };

  return {
    "sessions.list": ({
      query: { scope, archived = false, plugins: owned },
      caller,
    }) => {
      if (scope === "all" && !caller.admin) {
        throw new HttpError(
          403,
          "Only admins list everyone's Sessions.",
          "admin_only",
        );
      }

      if (scope === "team") {
        return sessions.list({
          archived,
          team: true,
          ...(!caller.admin && { person: caller.id }),
        });
      }

      const all = sessions.list({
        archived,
        ...(scope !== "all" && { person: caller.id }),
      });

      // An owned Session shows only inside its plugin, unless that plugin
      // is off (ADR 0028), or for search and notices.
      return owned === true
        ? all
        : all.filter(
            (session) =>
              session.plugin === null ||
              !plugins.names.includes(session.plugin.id),
          );
    },
    // A fork and a move to the team make a new Session too.
    "sessions.create": ({ body, caller }) => {
      // A body that misses one shape can fit another, so each is checked
      // again whole, to say what is wrong with the one it meant.
      if ("from" in body) {
        return "summary" in body || "owner" in body
          ? moved(checkBody(body, moveToTeam), caller)
          : forked(checkBody(body, forkSession), caller);
      }

      const created = ok(sessions.start({ ...body, actor: caller.actor }));

      log("session created", {
        sessionId: created.id,
        environmentId: created.environmentId,
        provider: created.provider,
      });

      return created;
    },
    "sessions.get": ({ params: { id }, caller }) => {
      const session = sessions.get(id);
      const sees = canSee(viewerOf(caller, false), sessions.owned(id));

      if (session === undefined || !(sees || caller.admin)) {
        throw new NotFound("Not found.");
      }

      return sees ? session : sessionOutline(session);
    },
    "sessions.events": ({ params: { id }, request, caller }) => {
      seen(id, caller);

      let send: (event: SessionEvent) => void = () => undefined;

      const watch = ok(
        sessions.watch(
          id,
          (event) => {
            send(event);
          },
          lineAfter(request.headers.get("last-event-id")),
        ),
      );

      return sseResponse((s) => {
        send = (event) => {
          s(event, event.type === "entry" ? String(event.line) : undefined);
        };

        watch.replay.forEach(send);

        return watch.stop;
      });
    },
    "sessions.update": ({
      params: { id },
      body: { archived, access },
      caller,
    }) => {
      if (access !== undefined) {
        limit(id, access, caller);
      }

      if (archived === true) {
        steered(id, caller);
        ok(sessions.archive(id, caller.actor));
        log("session archived", { sessionId: id });
      }

      if (archived === false) {
        steered(id, caller);
        ok(sessions.unarchive(id, caller.actor));
        log("session unarchived", { sessionId: id });
      }

      if (archived === undefined && access === undefined) {
        seen(id, caller);
      }

      const session = sessions.get(id);

      if (session === undefined) {
        throw new NotFound("Not found.");
      }

      return session;
    },
    "sessions.workspace.remove": ({ params: { id }, caller }) => {
      steered(id, caller);

      const removing = ok(sessions.forceRemoval(id));
      log("workspace removal forced", { sessionId: id });

      return removing;
    },
    "sessions.messages.create": ({ params: { id }, body, caller }) => {
      steered(id, caller);

      const { text, ...message } = body;

      ok(
        sessions.say(id, {
          ...message,
          text: text.trim(),
          actor: caller.actor,
        }),
      );

      return undefined;
    },
    "sessions.presence": ({ params: { id }, caller }) => {
      seen(id, caller);

      return sseResponse((send) =>
        present.join(id, caller.id, (watching) => {
          send(watching);
        }),
      );
    },
    "sessions.presence.typing": ({ params: { id }, caller }) => {
      steered(id, caller);
      present.typing(id, caller.id);

      return undefined;
    },
    "sessions.commands.create": ({ params: { id }, body, caller }) => {
      const { quote, ...sent } = body;
      const command = { ...sent, actor: caller.actor };
      const owned = sessions.owned(id);
      const viewer = viewerOf(caller, caller.admin);

      if (
        canSteer(viewer, owned) ||
        (command.type === "abort" && canManage(viewer, owned))
      ) {
        ok(sessions.send(id, command, quote));

        return undefined;
      }

      throw canSee(viewer, owned)
        ? rejection("view_only")
        : new NotFound("Not found.");
    },
  };
}

function viewerOf(caller: PersonCaller, admin: boolean): Viewer {
  return { id: caller.id, admin };
}

// What an admin sees of someone else's Session: never what they first asked
// (ADR 0049).
function sessionOutline(session: Session): Session {
  return { ...session, systemPrompt: null, firstMessage: null };
}

function lineAfter(lastEventId: string | null): number {
  const line = Number(lastEventId ?? "");

  return lastEventId !== null && Number.isSafeInteger(line) && line >= 0
    ? line + 1
    : 0;
}
