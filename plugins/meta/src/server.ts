import {
  BadRequest,
  NotFound,
  readBody,
  type ServerPlugin,
  type ServerPluginContext,
  type Static,
  Type,
} from "@pipoca/plugins";
import type { Actor, Session } from "@pipoca/protocol";
import { metaPrompt } from "./prompt";

const newMetaSession = Type.Object({
  text: Type.String(),
  model: Type.Optional(
    Type.Union([
      Type.Object({
        provider: Type.String({ minLength: 1 }),
        id: Type.String({ minLength: 1 }),
      }),
      Type.Null(),
    ]),
  ),
});

const assistantProfile = {
  packages: [],
  agentsMd: "",
  systemMd: "",
  appendSystemMd: metaPrompt,
  mcpServers: {},
};

const toolCall = Type.Object({
  tool: Type.String(),
  input: Type.Unknown(),
});

// Meta-sessions change Pipoca itself (ADR 0035). They run on the meta
// Profile and stay out of the Session list. So does the person's assistant
// Project, which runs on it too (ADR 0052).
export const meta: ServerPlugin = {
  name: "meta",
  register: (context) => {
    // Other Session parts would add tools the confirm can't see into, such
    // as subagents, whose own sessions don't load it. Logins adds no tools,
    // and without it a provider that needs a stored login has no models.
    context.sessions.loadOnly(["ask", "logins", "models", "meta"]);

    context.toolsets.loadInOwnSessions();

    // The assistant's coordinator reads but changes nothing on the runner,
    // and its threads build with all of Pi's tools (ADR 0052). Projects runs
    // both for the person's assistant Project.
    const profile = context.profiles.provide(
      "assistant",
      {
        ...assistantProfile,
        name: "Pipoca assistant",
        settings: {
          defaultTools: ["-bash", "-edit", "-write", "+grep", "+find", "+ls"],
        },
      },
      { sharedWith: ["projects"] },
    );

    context.profiles.provide(
      "builder",
      {
        ...assistantProfile,
        name: "Pipoca assistant thread",
        settings: { defaultTools: ["+grep", "+find", "+ls"] },
      },
      { sharedWith: ["projects"] },
    );

    context.routes.handle(async (request, path, caller) => {
      if (
        path === "asks" &&
        caller.kind === "session" &&
        request.method === "POST"
      ) {
        const { tool, input } = await readBody(request, toolCall);

        return Response.json({
          text:
            (await context.toolsets.asks(caller.session, tool, input)) ?? null,
        });
      }

      if (path !== "sessions" || caller.kind !== "user") {
        throw new NotFound(`no route ${path}`);
      }

      if (request.method === "GET") {
        return Response.json(
          context.sessions
            .owned(context.owner)
            .filter(
              ({ startedBy }) => caller.actor === `user:${startedBy ?? ""}`,
            ),
        );
      }

      if (request.method !== "POST") {
        throw new NotFound(`no route ${path}`);
      }

      return Response.json(
        start(
          context,
          caller.actor,
          profile,
          await readBody(request, newMetaSession),
        ),
        { status: 201 },
      );
    });
  },
};

function start(
  context: ServerPluginContext,
  user: Actor,
  profile: string,
  { text, model }: Static<typeof newMetaSession>,
): Session {
  if (text.trim() === "") {
    throw new BadRequest("text must not be empty");
  }

  try {
    return context.sessions.start(
      {
        actor: user,
        profile,
        workspace: { kind: "repositories", repositories: [] },
        firstMessage: text,
        ...(model && { model: { provider: model.provider, id: model.id } }),
      },
      context.owner,
    );
  } catch (error) {
    throw new BadRequest(
      error instanceof Error ? error.message : String(error),
    );
  }
}
