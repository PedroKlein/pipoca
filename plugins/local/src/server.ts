import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  type Retry,
  retryAfter,
  BadRequest,
  defineServer,
  NotFound,
  type Person,
  Type,
} from "@pipoca/plugins";
import type { Environment } from "@pipoca/protocol";
import { local } from "../plugin";
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

// One runner names itself the same each time, so a Session it held before it
// stopped comes back to the next one.
const runnerName = "this-machine";

const intervalMs = 1000;

// How long an Environment waits after its runner fails, doubling with each
// failure in a row.
const retryAfterMs = 10_000;

interface Failure extends Retry {
  readonly problem: string;
  readonly at: number;
}

// Starts a runner on the server's own machine when one of its Environments
// has a Session no runner can take, and lets it exit when idle (ADR 0053).
export const server = defineServer(
  local,
  ({ clock, environments, log, provide, routes, schedule, signal, store }) => {
    const settings = settingsStore(store);
    const failures = new Map<string, Failure>();
    const processes = new Map<string, Bun.Subprocess>();

    const owned = (person: Person, id: string): Environment => {
      const found = environments.get(id);

      if (found?.ownerId !== person.id) {
        throw new NotFound(`no Environment ${id}`);
      }

      return found;
    };

    const answer = (environmentId: string): LocalEnvironment => ({
      settings: settings.get(environmentId) ?? null,
      lastFailure: publicFailure(failures.get(environmentId)),
    });

    routes.get("environments/:id", { auth: "person" }, ({ caller, params }) =>
      answer(owned(caller.person, params.id).id),
    );

    routes.post(
      "environments/:id",
      { auth: "person", body: settingsChange },
      ({ caller, params, body }) => {
        const { id } = owned(caller.person, params.id);

        if (body.settings === null) {
          settings.remove(id);
        } else {
          settings.set(id, settingsFrom(body.settings));
        }

        failures.delete(id);

        log(
          body.settings === null
            ? "local runner settings removed"
            : "local runner settings saved",
          { environmentId: id },
        );

        return answer(id);
      },
    );

    const { solo } = provide.runtime();

    if (solo !== undefined) {
      settings.set(solo.environmentId, {
        ...defaultSettings,
        folders: solo.folders,
      });
    }

    const runners = provide.runners({
      kind: { label: "This machine", icon: "monitor" },
      starts: (environment) => settings.get(environment.id) !== undefined,
    });

    const start = (environment: Environment, own: LocalSettings): void => {
      const { command, serverUrl, dataDir } = provide.runtime();
      const token = runners.token(environment.id, runnerName);

      const runner = Bun.spawn(
        [
          ...command,
          "agent",
          "--name",
          runnerName,
          "--server",
          serverUrl,
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

      processes.set(environment.id, runner);

      log("local runner started", {
        environmentId: environment.id,
        pid: runner.pid,
      });

      void runner.exited.then((code) => {
        processes.delete(environment.id);

        // The server stopped it, and its database is gone.
        if (signal.aborted) {
          return;
        }

        runners.revoke(environment.id, runnerName);

        if (code === 0) {
          failures.delete(environment.id);
          log("local runner stopped", { environmentId: environment.id });

          return;
        }

        const now = clock.now();

        const failure = {
          ...retryAfter(failures.get(environment.id), now, retryAfterMs),
          problem: `its runner exited with code ${String(code)}`,
          at: now,
        };

        failures.set(environment.id, failure);

        log("local runner failed", {
          environmentId: environment.id,
          problem: failure.problem,
          retryAt: new Date(failure.retryAt).toISOString(),
        });
      });
    };

    schedule.every("reconcile", intervalMs, () => {
      for (const environment of environments.list()) {
        const own = settings.get(environment.id);
        const failure = failures.get(environment.id);

        if (
          own === undefined ||
          processes.has(environment.id) ||
          (failure !== undefined && failure.retryAt > clock.now()) ||
          runners.unplaced(environment.id).length === 0
        ) {
          continue;
        }

        start(environment, own);
      }
    });

    signal.addEventListener("abort", () => {
      for (const runner of processes.values()) {
        runner.kill("SIGTERM");
      }
    });
  },
);

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

function publicFailure(failure: Failure | undefined): RunnerFailure | null {
  return failure === undefined
    ? null
    : {
        problem: failure.problem,
        at: new Date(failure.at).toISOString(),
        retryAt: new Date(failure.retryAt).toISOString(),
      };
}
