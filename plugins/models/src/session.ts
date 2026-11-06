import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRoute,
  ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import { defineSession, type SessionContext } from "@pipoca/plugins";
import { models } from "../plugin";
import { aliasesOf, candidates, failure, gatewayProvider } from "./gateway";
import {
  mergeHealth,
  type ModelRef,
  noHealth,
  type SessionConfig,
  thinkingLevels,
} from "./model";

const pauseMs = 1000;

// Registers the Environment's aliases as Pi virtual models under the gateway
// provider. Each request goes to the alias's first healthy model, and a model
// or provider that fails is reported so every Session in the Environment
// stops using it.
export const session = defineSession(models, (s) => {
  s.extension(async (pi) => {
    const first = await read(s, undefined, undefined).catch(
      (error: unknown) => {
        s.log("model aliases not read", { error: String(error) });

        return undefined;
      },
    );

    let config = first ?? { version: 0, aliases: null, health: noHealth };
    let registered: readonly string[] = [];

    const register = (): void => {
      const aliases = config.aliases ? aliasesOf(config.aliases) : [];

      for (const alias of registered) {
        if (!aliases.includes(alias)) {
          pi.unregisterVirtualModel(gatewayProvider, alias);
        }
      }

      for (const alias of aliases) {
        try {
          pi.registerVirtualModel({
            provider: gatewayProvider,
            id: alias,
            name: alias,
            thinkingLevels,
            route: (request, ctx) =>
              routeModel(config, alias, request, ctx, s.clock.now()),
          });
        } catch (error) {
          s.log("model alias not registered", {
            alias,
            error: String(error),
          });
        }
      }

      registered = aliases;
    };

    register();

    const report = (model: ModelRef, errorMessage: string): void => {
      const now = new Date(s.clock.now());

      const failed = config.aliases
        ? failure(config.aliases, model, errorMessage, now)
        : undefined;

      if (failed === undefined) {
        return;
      }

      const { key, entry } = failed;

      const health = mergeHealth(
        config.health,
        { version: 1, unhealthyUntil: { [key]: entry } },
        now,
      );

      config = { ...config, health };
      s.log("model unhealthy", { model: key, until: entry.until });

      s.api.post("health", health).catch((error: unknown) => {
        s.log("model health not reported", { error: String(error) });
      });
    };

    pi.on("message_end", (event, ctx) => {
      const { message } = event;
      if (
        message.role === "assistant" &&
        message.stopReason === "error" &&
        ctx.model?.provider === gatewayProvider
      ) {
        report(
          { provider: message.provider, id: message.model },
          message.errorMessage ?? "",
        );
      }
    });

    follow(pi, s, first?.version, (next) => {
      const aliasesChanged =
        JSON.stringify(next.aliases) !== JSON.stringify(config.aliases);

      config = next;
      if (aliasesChanged) {
        register();
      }
    });
  });
});

// Tool follow-ups and retries stay on the model that answered, which keeps
// the prompt cache, unless that model has since become unhealthy.
function stickyOf(request: ModelRouteRequest): ModelRouteRequest["previous"] {
  switch (request.reason) {
    case "continuation":
      return request.previous;
    case "retry":
      return request.failed;
    case "user":
    case "direct":
      return undefined;
  }
}

function routeModel(
  config: SessionConfig,
  alias: string,
  request: ModelRouteRequest,
  ctx: ExtensionContext,
  now: number,
): ModelRoute {
  const routable = candidates(
    config.aliases ?? { models: {} },
    config.health,
    alias,
    new Date(now),
  );

  const sticky = stickyOf(request);

  const kept = routable.find(
    ({ provider, id }) =>
      provider === sticky?.model.provider && id === sticky.model.id,
  );

  if (sticky && kept) {
    return {
      model: sticky.model,
      thinkingLevel: kept.thinking ?? request.thinkingLevel,
    };
  }

  for (const { provider, id, thinking } of routable) {
    const model = ctx.modelRegistry.find(provider, id);
    if (model && ctx.modelRegistry.hasConfiguredAuth(model)) {
      return { model, thinkingLevel: thinking ?? request.thinkingLevel };
    }
  }

  throw new Error(
    `no healthy, signed-in model for ${gatewayProvider}/${alias}`,
  );
}

async function read(
  { api }: Pick<SessionContext, "api">,
  after: number | undefined,
  signal: AbortSignal | undefined,
): Promise<SessionConfig> {
  return api.get<SessionConfig>("config", { after }, signal && { signal });
}

// Waits for the server's next change to the config or health, until the
// Session shuts down. Without a version it reads the config at once. After an
// error or an answer that came at once it pauses, so a failing or fast server
// can't make it spin.
function follow(
  pi: ExtensionAPI,
  s: Pick<SessionContext, "api" | "clock" | "log" | "timer">,
  version: number | undefined,
  changed: (config: SessionConfig) => void,
): void {
  const stop = new AbortController();
  const stopped = (): boolean => stop.signal.aborted;

  pi.on("session_shutdown", () => {
    stop.abort();
  });

  void (async () => {
    let seen = version;
    while (!stop.signal.aborted) {
      const asked = s.clock.now();
      let failed = false;

      try {
        const next = await read(s, seen, stop.signal);
        if (next.version !== seen) {
          seen = next.version;
          changed(next);
        }
      } catch (error) {
        if (stopped()) {
          return;
        }

        failed = true;
        s.log("model aliases not followed", { error: String(error) });
      }

      if (failed || s.clock.now() - asked < pauseMs) {
        await new Promise<void>((resolve) => {
          s.timer.after(pauseMs, async () => {
            resolve();

            return Promise.resolve();
          });
        });
      }
    }
  })();
}
