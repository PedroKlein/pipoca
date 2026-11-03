import { NotFound, type ServerPlugin } from "@pipoca/plugins";
import { wakeUps } from "./wakeups";

export const routines: ServerPlugin = {
  name: "routines",
  register: (context) => {
    const wakeups = wakeUps(context);

    context.routes.handle((request, path, caller) => {
      if (caller.kind !== "user") {
        throw new NotFound(`no route ${path}`);
      }

      const userId = caller.actor.slice("user:".length);
      const [route, id] = path.split("/");

      if (route === "wakeups" && id === undefined && request.method === "GET") {
        const session = new URL(request.url).searchParams.get("session") ?? "";

        return Response.json(wakeups.pending(userId, session));
      }

      if (
        route === "wakeups" &&
        id !== undefined &&
        request.method === "DELETE"
      ) {
        wakeups.cancel(userId, id);

        return Response.json({ ok: true });
      }

      throw new NotFound(`no route ${path}`);
    });
  },
};
