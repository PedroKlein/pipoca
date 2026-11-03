import { NotFound, readJson, type ServerPlugin } from "@pipoca/plugins";
import { routinesEngine } from "./engine";
import { wakeUps } from "./wakeups";

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

    context.routes.handle(async (request, path, caller) => {
      if (caller.kind !== "user") {
        throw new NotFound(`no route ${path}`);
      }

      const userId = caller.actor.slice("user:".length);
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

      if (route !== "routines") {
        throw new NotFound(`no route ${path}`);
      }

      if (id === undefined && method === "GET") {
        return Response.json(engine.list(userId));
      }

      if (id !== undefined && action === undefined) {
        switch (method) {
          case "GET":
            return Response.json(engine.get(userId, id));
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
