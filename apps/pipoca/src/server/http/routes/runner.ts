import { HttpError, NotFound } from "@pipoca/plugins";
import {
  type Command,
  loggedStart,
  sseResponse,
  type Work,
} from "@pipoca/protocol";
import type { ApiDeps, Group } from "../deps";
import { ok, rejection } from "../replies";
import type { Handlers } from "../router";

// What runners and the Session hosts they start call (ADR 0033).
export function runnerRoutes({
  runners,
  sessions,
  environments,
  profiles,
  plugins,
  log,
}: ApiDeps): Handlers<Group<"runner">> {
  // The Session at its current generation, which a stale host can't reach.
  const current = (id: string, generation: number): void => {
    if (!sessions.get(id) || !sessions.isCurrent(id, generation)) {
      throw rejection("stale_generation");
    }
  };

  return {
    "runner.join": ({ request, body: { name } }) => {
      const [scheme, key] = (request.headers.get("authorization") ?? "").split(
        " ",
      );

      const joined =
        scheme === "Bearer" && key !== undefined
          ? runners.join(key, name, {
              create: (runner, ownerId) => {
                const created = environments.createForRunner(runner, ownerId);

                log("environment created", {
                  environmentId: created.id,
                  runner,
                });

                return created.provider;
              },
              online: (environment, runner) =>
                environments.online(environment, runner),
            })
          : undefined;

      if (joined === undefined) {
        log("runner refused", { runner: name });

        throw new HttpError(
          401,
          "The server doesn't know this join key.",
          "unknown_key",
        );
      }

      if (joined === "online") {
        log("runner refused", { runner: name, reason: "online" });

        throw new HttpError(
          409,
          `a runner named ${name} is online here`,
          "runner_online",
        );
      }

      log("runner joined", { runner: name, environment: joined.environment });

      return joined;
    },
    "runner.work": async ({ request, body, caller }) => {
      const runner = { name: caller.runner, environment: caller.environment };

      const { start, unload, remove, interrupted } = await sessions.claim(
        runner,
        body,
        request.signal,
      );

      // The plugin that started the runner may have revoked it during the
      // poll, and a revoked runner must not get Session tokens.
      if (runners.callerOf(request) === undefined) {
        throw new HttpError(
          401,
          "The server doesn't know this token.",
          "unknown_token",
        );
      }

      const fields = {
        provider: runner.name,
        environment: runner.environment,
      };

      for (const attempt of interrupted) {
        log("session interrupted", { ...fields, ...attempt });
      }

      for (const assignment of start) {
        log("session assigned", { ...fields, ...loggedStart(assignment) });
      }

      for (const attempt of unload) {
        log("session unloading", { ...fields, ...attempt });
      }

      return {
        start: start.map((assignment) => ({
          ...assignment,
          token: runners.sessionToken(caller, assignment.sessionId),
        })),
        unload,
        remove,
        profiles: [...profiles.ids(), ...plugins.profileIds()],
      } satisfies Work;
    },
    "runner.transcript": ({ params: { id } }) => ({
      entries: sessions.transcript(id),
    }),
    "runner.transcript.append": ({ params: { id }, body }) =>
      ok(sessions.appendTranscript(id, body)),
    "runner.startFailure": ({ params: { id }, body }) => {
      log("session failed to start", { sessionId: id, ...body });
      ok(sessions.fail(id, body));

      return undefined;
    },
    "runner.trust": ({ params: { id }, body }) => {
      log("repository trust answered", { sessionId: id, ...body });
      ok(sessions.trust(id, body));

      return undefined;
    },
    "runner.workspaceRemoval": ({ params: { id }, body }) => {
      log("workspace removal reported", { sessionId: id, ...body });
      ok(sessions.reportRemoval(id, body));

      return undefined;
    },
    "runner.events": ({ params: { id }, body }) => {
      ok(sessions.publish(id, body));

      return undefined;
    },
    "runner.commands": ({ params: { id }, query: { generation, ack } }) => {
      // Commands held for the Session arrive while it attaches, before the
      // stream opens.
      const early: [Command, number | undefined][] = [];

      let send = (command: Command, seq?: number): boolean => {
        early.push([command, seq]);

        return true;
      };

      let end = (): void => undefined;

      const stop = ok(
        sessions.attach(
          id,
          generation,
          (command, seq) => send(command, seq),
          () => {
            end();
          },
          ack,
        ),
      );

      return sseResponse((sendEvent, endStream) => {
        send = (command, seq) =>
          sendEvent(command, seq === undefined ? undefined : String(seq));

        end = endStream;

        early.forEach(([command, seq]) => {
          send(command, seq);
        });

        return stop;
      });
    },
    "runner.acks.create": ({ params: { id }, body: { generation, seq } }) => {
      ok(sessions.ack(id, generation, seq));

      return undefined;
    },
    "runner.tools": ({ params: { id }, query }) => {
      current(id, query.generation);

      const session = sessions.get(id);

      return session === undefined ? [] : plugins.tools(session);
    },
    "runner.toolCalls.create": ({ params: { id }, body }) => {
      current(id, body.generation);

      const session = sessions.get(id);

      if (session !== undefined) {
        plugins.call(session, body);
      }

      return undefined;
    },
    "runner.toolQuestions.create": async ({
      params: { id },
      body: { generation, name, input },
    }) => {
      current(id, generation);

      const session = sessions.get(id);

      return {
        question:
          (session && (await plugins.question(session, name, input))) ?? null,
      };
    },
    // The files of the Session's Profile, which the runner downloads when
    // its copy's hash differs (ADR 0041).
    "runner.profile": ({ params: { id } }) => {
      const session = sessions.get(id);
      const files = session && sessions.profileFiles(session);

      if (!files) {
        throw new NotFound("Not found.");
      }

      return files;
    },
    // The docs every Session gets as files (ADR 0052).
    "runner.docs": () => {
      const docs = sessions.docs();

      if (!docs) {
        throw new NotFound("Not found.");
      }

      return docs;
    },
    "runner.part": ({ params: { plugin, hash } }) => {
      const path = plugins.sessionPart(plugin, hash);

      if (path === undefined) {
        throw new NotFound("Not found.");
      }

      return new Response(Bun.file(path));
    },
    "runner.ext": async ({ request, params: { id, plugin, path } }) => {
      const session = sessions.get(id);

      const generation = Number(
        new URL(request.url).searchParams.get("generation") ?? NaN,
      );

      if (!session || !sessions.isCurrent(id, generation)) {
        throw rejection("stale_generation");
      }

      const routed = await plugins.route(request, plugin, path, {
        kind: "session",
        session,
        actor: `session:${id}`,
      });

      if (routed === undefined) {
        throw new NotFound("Not found.");
      }

      return routed;
    },
  };
}
