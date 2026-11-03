import {
  HttpError,
  NotFound,
  readJson,
  type RouteCaller,
  type ServerPlugin,
} from "@pipoca/plugins";
import { routinesEngine } from "./engine";
import { wakeUps } from "./wakeups";

const maxHookBody = 1024 * 1024;

export const routines: ServerPlugin = {
  name: "routines",
  register: (context) => {
    const wakeups = wakeUps(context);
    const engine = routinesEngine(context);

    context.tools.register({
      name: "report_nothing",
      description:
        "This routine run found nothing to do: call it instead of writing a result, then end your turn. The run is recorded as nothing and nobody is told.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      exposure: "direct",
      annotations: { readOnlyHint: false, destructiveHint: false },
      appliesTo: (session) => session.owner?.plugin === "routines",
      run: async (_input, { session }) => {
        await Promise.resolve();

        try {
          return { text: engine.reportNothing(session), isError: false };
        } catch (error) {
          return {
            text: error instanceof Error ? error.message : String(error),
            isError: true,
          };
        }
      },
    });

    context.auth.handlePublic(async (request, path) => {
      const [route, id, extra] = path.split("/");

      if (
        route !== "hooks" ||
        id === undefined ||
        extra !== undefined ||
        request.method !== "POST"
      ) {
        return undefined;
      }

      const body = await request.text();

      if (body.length > maxHookBody) {
        return refusal(413, "too_large", "a webhook's body is at most 1 MB");
      }

      const outcome = engine.hook(
        id,
        body,
        request.headers.get("x-pipoca-signature") ??
          request.headers.get("x-hub-signature-256"),
      );

      switch (outcome) {
        case "accepted":
          return Response.json({ ok: true }, { status: 202 });
        case "unknown":
          return refusal(404, "not_found", "no such webhook");
        case "unsigned":
          return refusal(
            401,
            "unauthorized",
            "sign the body with the routine's secret, as sha256=<HMAC-SHA256 in hex> in X-Pipoca-Signature",
          );
      }
    });

    context.routes.handle(async (request, path, caller) => {
      const userId = personOf(caller);
      const [route, id, action] = path.split("/");
      const method = request.method;

      if (route === "wakeups" && id === undefined && method === "GET") {
        const session = new URL(request.url).searchParams.get("session") ?? "";

        return Response.json(wakeups.pending(userId, session));
      }

      if (route === "wakeups" && id !== undefined && method === "DELETE") {
        wakeups.cancel(userId, id);

        return Response.json({ ok: true });
      }

      if (route === "events" && method === "GET") {
        return Response.json(context.events.declared());
      }

      if (route !== "routines") {
        throw new NotFound(`no route ${path}`);
      }

      if (id === undefined && method === "GET") {
        return Response.json(engine.list(userId));
      }

      if (id !== undefined && action === undefined) {
        switch (method) {
          case "GET": {
            const { webhook, ...detail } = engine.get(userId, id);

            // An agent learns where the webhook is, never its secret.
            return Response.json(
              caller.kind === "user" || webhook === undefined
                ? { ...detail, ...(webhook && { webhook }) }
                : { ...detail, webhook: { path: webhook.path } },
            );
          }

          case "PUT":
            engine.save(userId, id, await readJson(request));

            return Response.json(engine.get(userId, id));
          case "DELETE":
            engine.remove(userId, id);

            return Response.json({ ok: true });
        }
      }

      if (id !== undefined && method === "POST" && action === "run") {
        return Response.json(engine.runNow(userId, id), { status: 201 });
      }

      if (
        id !== undefined &&
        method === "POST" &&
        (action === "pause" || action === "resume")
      ) {
        engine.pause(userId, id, action === "pause");

        return Response.json(engine.get(userId, id));
      }

      throw new NotFound(`no route ${path}`);
    });
  },
};

// A Session acts for the person who started it, except a routine's own run,
// so routines can't make routines (ADR 0059).
function personOf(caller: RouteCaller): string {
  if (caller.kind === "user") {
    return caller.actor.slice("user:".length);
  }

  if (caller.session.owner?.plugin === "routines") {
    throw new HttpError(403, "a routine's run can't change routines");
  }

  if (caller.session.startedBy === null) {
    throw new HttpError(403, "only a Session a person started can do this");
  }

  return caller.session.startedBy;
}

function refusal(status: number, error: string, message: string): Response {
  return Response.json({ error, message }, { status });
}
