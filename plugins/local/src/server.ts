import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  BadRequest,
  NotFound,
  readBody,
  type ServerPlugin,
  Type,
} from "@pipoca/plugins";
import type { Environment } from "@pipoca/protocol";
import {
  defaultSettings,
  type LocalEnvironment,
  type LocalSettings,
  type RunnerFailure,
  settingsStore,
} from "./settings";

const positive = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});

// Null settings stop starting runners for the Environment.
const settingsChange = Type.Object({
  settings: Type.Union([
    Type.Object({
      capacity: Type.Optional(positive),
      idleSeconds: Type.Optional(positive),
      folders: Type.Optional(Type.Array(Type.String())),
    }),
    Type.Null(),
  ]),
});

export interface LocalOptions {
  // The pipoca binary, which the runner runs as `pipoca agent`.
  readonly command: readonly string[];
  // The address runners poll, known once the server listens.
  readonly server: () => string;
  // Each Environment's runner keeps its data in a folder of its own here.
  readonly dataDir: string;
  // An Environment the server just made for this machine, whose runner
  // starts with the default settings, sharing these folders.
  readonly seed?: {
    readonly environmentId: string;
    readonly folders: readonly string[];
  };
  readonly intervalMs?: number;
  // How long an Environment waits after its runner fails. It doubles with
  // each failure in a row, up to 32 times as long.
  readonly retryAfterMs?: number;
}

// One runner names itself the same each time, so a Session it held before it
// stopped comes back to the next one.
const runnerName = "this-machine";

interface Failure extends RunnerFailure {
  readonly inARow: number;
}

// Starts a runner on the server's own machine when one of its Environments
// has a Session no runner can take, and lets it exit when idle (ADR 0053).
// The server adds it only to a solo install.
export function local(options: () => LocalOptions): ServerPlugin {
  return {
    name: "local",
    register: (context) => {
      const settings = settingsStore(context.store);
      const failures = new Map<string, Failure>();
      const runners = new Map<string, Bun.Subprocess>();

      const {
        command,
        server,
        dataDir,
        seed,
        intervalMs = 1000,
        retryAfterMs = 10_000,
      } = options();

      const answer = (environmentId: string): Response =>
        Response.json({
          settings: settings.get(environmentId) ?? null,
          lastFailure: publicFailure(failures.get(environmentId)),
        } satisfies LocalEnvironment);

      context.routes.handle(async (request, path, caller) => {
        const [resource, id] = path.split("/");

        const environment = context.environments
          .list()
          .find((each) => each.id === id);

        if (
          caller.kind !== "user" ||
          resource !== "environments" ||
          environment?.ownerId !== caller.actor.slice("user:".length) ||
          (request.method !== "GET" && request.method !== "POST")
        ) {
          throw new NotFound(`no route ${path}`);
        }

        if (request.method === "GET") {
          return answer(environment.id);
        }

        const body = await readBody(request, settingsChange);

        if (body.settings === null) {
          settings.remove(environment.id);
        } else {
          settings.set(environment.id, settingsFrom(body.settings));
        }

        failures.delete(environment.id);

        context.log(
          body.settings === null
            ? "local runner settings removed"
            : "local runner settings saved",
          { environmentId: environment.id },
        );

        return answer(environment.id);
      });

      if (seed !== undefined) {
        settings.set(seed.environmentId, {
          ...defaultSettings,
          folders: seed.folders,
        });
      }

      context.environments.startsRunners(
        (environment) => settings.get(environment.id) !== undefined,
      );

      const start = (environment: Environment, own: LocalSettings): void => {
        const token = context.environments.runnerToken(
          environment.id,
          runnerName,
        );

        const runner = Bun.spawn(
          [
            ...command,
            "agent",
            "--name",
            runnerName,
            "--server",
            server(),
            "--capacity",
            String(own.capacity),
            "--exit-when-idle",
            String(own.idleSeconds),
            "--data-dir",
            join(dataDir, environment.id),
            ...own.folders.flatMap((folder) => ["--folder", folder]),
          ],
          {
            env: { ...process.env, PIPOCA_TOKEN: token },
            stdio: ["ignore", "inherit", "inherit"],
          },
        );

        runners.set(environment.id, runner);

        context.log("local runner started", {
          environmentId: environment.id,
          pid: runner.pid,
        });

        void runner.exited.then((code) => {
          runners.delete(environment.id);
          context.environments.revokeRunner(environment.id, runnerName);

          if (code === 0 || context.signal.aborted) {
            failures.delete(environment.id);

            context.log("local runner stopped", {
              environmentId: environment.id,
            });

            return;
          }

          const failure = nextFailure(
            failures.get(environment.id),
            `its runner exited with code ${String(code)}`,
            retryAfterMs,
          );

          failures.set(environment.id, failure);

          context.log("local runner failed", {
            environmentId: environment.id,
            problem: failure.problem,
            retryAt: failure.retryAt,
          });
        });
      };

      const reconcile = (): void => {
        const now = Date.now();

        for (const environment of context.environments.list()) {
          const own = settings.get(environment.id);
          const failure = failures.get(environment.id);

          if (
            own === undefined ||
            runners.has(environment.id) ||
            (failure !== undefined && Date.parse(failure.retryAt) > now) ||
            context.environments.unplaced(environment.id).length === 0
          ) {
            continue;
          }

          start(environment, own);
        }
      };

      context.signal.addEventListener("abort", () => {
        for (const runner of runners.values()) {
          runner.kill("SIGTERM");
        }
      });

      // The first pass waits a tick: the server finishes starting plugins
      // before their context answers.
      void (async () => {
        while (
          await sleep(intervalMs, undefined, { signal: context.signal }).then(
            () => true,
            () => false,
          )
        ) {
          try {
            reconcile();
          } catch (error) {
            context.log("local runners not reconciled", {
              error: String(error),
            });
          }
        }
      })();
    },
  };
}

// A change leaves out what keeps its default. A folder is shared as the
// runner's own path, so it has to be one this machine has.
function settingsFrom(change: Partial<LocalSettings>): LocalSettings {
  const folders = (change.folders ?? defaultSettings.folders).map((folder) => {
    const path = folder.startsWith("~/")
      ? join(homedir(), folder.slice(2))
      : folder;

    if (
      !isAbsolute(path) ||
      statSync(path, { throwIfNoEntry: false })?.isDirectory() !== true
    ) {
      throw new BadRequest(`${folder} isn't a folder on this machine`);
    }

    return path;
  });

  return { ...defaultSettings, ...change, folders };
}

function nextFailure(
  last: Failure | undefined,
  problem: string,
  retryAfterMs: number,
): Failure {
  const inARow = (last?.inARow ?? 0) + 1;
  const at = Date.now();
  const wait = retryAfterMs * 2 ** Math.min(inARow - 1, 5);

  return {
    problem,
    at: new Date(at).toISOString(),
    retryAt: new Date(at + wait).toISOString(),
    inARow,
  };
}

function publicFailure(failure: Failure | undefined): RunnerFailure | null {
  return failure === undefined
    ? null
    : { problem: failure.problem, at: failure.at, retryAt: failure.retryAt };
}
