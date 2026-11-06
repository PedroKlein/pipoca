import { BadRequest, HttpError } from "@pipoca/plugins";
import { VERSION as piVersion } from "@earendil-works/pi-coding-agent";
import { version as serverVersion } from "../../../../package.json";
import { mcpHandler } from "../../../mcp";
import type { ApiDeps, Group } from "../deps";
import type { Handlers } from "../router";

// Tells one run of the server from the next, so a page waiting out a restart
// knows when the new one answers.
const started = new Date().toISOString();

export function serverRoutes({
  people,
  plugins,
  changes,
  checkStore,
  restart,
  log,
}: ApiDeps): Handlers<"health" | "mcp" | "changes" | Group<"server">> {
  const mcp = mcpHandler(people, plugins, serverVersion, log);

  return {
    health: () => {
      try {
        checkStore();
      } catch (error) {
        log("database unavailable", { error: String(error) });

        return Response.json({ status: "unavailable" }, { status: 503 });
      }

      return { status: "ok", version: serverVersion, pi: piVersion, started };
    },
    mcp: async ({ request }) => mcp(request),
    changes: () => changes.stream(),
    "server.restart": ({ body: { force } }) => {
      if (restart === undefined) {
        throw new BadRequest(
          "nothing starts this server again when it stops, so restart it yourself",
        );
      }

      const busy = restart.busy();

      // Sessions on the server's own runner stop with it mid-turn
      // (ADR 0022), so the user decides.
      if (busy > 0 && force !== true) {
        throw new HttpError(
          409,
          "Sessions are mid-turn on the server's own runner.",
          "busy",
          { sessions: busy },
        );
      }

      log("server restarting", { interrupted: busy });

      // After the answer is on its way.
      setTimeout(restart.now, 100);

      return undefined;
    },
  };
}
