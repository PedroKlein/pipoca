import type { ModelOffer } from "@pipoca/plugins/host";
import {
  type Clock,
  type Environment,
  type EnvironmentTemplate,
  type EnvironmentUpdate,
  leaseMs,
  type ModelInfo,
  type ReachedHost,
  repositoryHost,
  type RunnersFrom,
  type SessionEnvironment,
  systemClock,
  type WorkPoll,
  type Workspace,
  type WorkspaceRequest,
} from "@pipoca/protocol";
import {
  type Placeable,
  placesOn,
  placesOnNewRunner,
  uniqueModels,
} from "./placement";
import { type PolledRunner, RunnerPolls } from "./runner-polls";

export type StoredEnvironment = Omit<
  Environment,
  | "online"
  | "onDemand"
  | "runnersFrom"
  | "runners"
  | "folders"
  | "reaches"
  | "models"
  | "hiddenModels"
  | "unavailableModels"
  | "registeredModels"
  | "secrets"
> & { readonly secrets: Readonly<Record<string, string>> };

export interface EnvironmentStore {
  // Its owner is a person's id or "team". Its name is its provider's
  // unless one is given.
  readonly ensureEnvironment: (
    provider: string,
    ownerId: string,
    templateId?: string | null,
    name?: string,
  ) => void;
  readonly environments: () => readonly StoredEnvironment[];
  readonly updateEnvironment: (environment: StoredEnvironment) => void;
  // With its runners' tokens and its Sessions, transcripts included.
  readonly deleteEnvironment: (id: string) => void;
  // The models each runner of an Environment last reported (ADR 0044).
  readonly registeredModels: (provider: string) => readonly ModelInfo[];
  readonly setRegisteredModels: (
    provider: string,
    runner: string,
    models: readonly ModelInfo[],
  ) => void;
}

export type Rejection =
  | "unknown_environment"
  | "environment_exists"
  | "unknown_template"
  | "from_template"
  | "environment_in_use";

export type Result<T, R extends Rejection = Rejection> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: R };

export interface EnvironmentsOptions {
  readonly pollWaitMs?: number;
  readonly offlineAfterMs?: number;
  readonly leaseMs?: number;
  readonly clock?: Clock;
  // The admins' Environment templates (ADR 0049).
  readonly templates?: () => readonly EnvironmentTemplate[];
  readonly offeredModels?: ModelOffer;
  // The plugin that starts runners for the Environment on demand, if any.
  readonly startsRunners?: (
    environment: Pick<Environment, "id" | "templateId">,
  ) => RunnersFrom | undefined;
  // What the Environments' Sessions are doing.
  readonly sessions?: () => {
    readonly running: (provider: string, runner: string) => number;
    readonly inUse: (environmentId: string) => boolean;
    // Its Sessions went with a deleted Environment.
    readonly removed: () => void;
  };
  // Whether a host is one the server reaches only through Environments
  // (ADR 0080).
  readonly privateHost?: (host: string) => boolean;
  // Called whenever a runner comes online or goes offline.
  readonly onlineChanged?: (provider: string, runner: string) => void;
  // Called whenever an Environment or its runners change.
  readonly changed?: () => void;
}

type Inventory = Pick<WorkPoll, "folders" | "models" | "session" | "reach">;

const noSessions = {
  running: () => 0,
  inUse: () => false,
  removed: () => undefined,
};

// Where Sessions run: each Environment, its settings or template, and the
// pool of runners that poll for its work (ADR 0032, ADR 0049).
export class Environments {
  readonly #store: EnvironmentStore;
  readonly #polls: RunnerPolls;
  readonly #templates: () => readonly EnvironmentTemplate[];
  readonly #offeredModels: ModelOffer;
  readonly #startsRunners: NonNullable<EnvironmentsOptions["startsRunners"]>;
  readonly #sessions: NonNullable<EnvironmentsOptions["sessions"]>;
  readonly #changed: () => void;
  readonly #privateHost: (host: string) => boolean;
  readonly #reported = new Map<string, string>();

  constructor(store: EnvironmentStore, options: EnvironmentsOptions = {}) {
    this.#store = store;
    this.#templates = options.templates ?? (() => []);
    this.#offeredModels = options.offeredModels ?? (() => ({ models: [] }));
    this.#startsRunners = options.startsRunners ?? (() => undefined);
    this.#sessions = options.sessions ?? (() => noSessions);
    this.#changed = options.changed ?? (() => undefined);
    this.#privateHost = options.privateHost ?? (() => false);
    const onlineChanged = options.onlineChanged ?? (() => undefined);

    this.#polls = new RunnerPolls({
      clock: options.clock ?? systemClock,
      pollWaitMs: options.pollWaitMs ?? 10_000,
      offlineAfterMs: options.offlineAfterMs ?? 30_000,
      leaseMs: options.leaseMs ?? leaseMs,
      onlineChanged: (provider, runner) => {
        this.#changed();
        onlineChanged(provider, runner);
      },
    });
  }

  all(): readonly StoredEnvironment[] {
    return this.#store.environments();
  }

  get(id: string): StoredEnvironment | undefined {
    return this.all().find((each) => each.id === id);
  }

  templates(): readonly EnvironmentTemplate[] {
    return this.#templates();
  }

  // Names clash only within an owner's own Environments; another owner's
  // of the same name gets a numbered provider.
  create(
    name: string,
    ownerId: string,
    templateId?: string,
  ): Result<Environment, "environment_exists" | "unknown_template"> {
    if (
      this.all().some((each) => each.ownerId === ownerId && each.name === name)
    ) {
      return { ok: false, reason: "environment_exists" };
    }

    if (templateId !== undefined && this.#template(templateId) === undefined) {
      return { ok: false, reason: "unknown_template" };
    }

    const provider = this.#freeProvider(name);
    this.#store.ensureEnvironment(provider, ownerId, templateId, name);

    const created = this.list().find((each) => each.provider === provider);

    if (!created) {
      throw new Error(`environment ${provider} was not stored`);
    }

    return { ok: true, value: created };
  }

  // A runner that joins with a join key gets an Environment of its own
  // name, numbered when another Environment has it.
  createForRunner(runner: string, ownerId: string): Environment {
    const created = this.create(this.#freeProvider(runner), ownerId);

    if (!created.ok) {
      throw new Error(`environment for ${runner} was not made`);
    }

    this.#changed();

    return created.value;
  }

  #freeProvider(name: string): string {
    const taken = new Set(this.all().map(({ provider }) => provider));

    let provider = name;
    for (let n = 2; taken.has(provider); n++) {
      provider = `${name.slice(0, 60)}-${String(n)}`;
    }

    return provider;
  }

  update(
    id: string,
    update: EnvironmentUpdate,
  ): Result<Environment, "unknown_environment" | "from_template"> {
    const environment = this.get(id);

    if (!environment) {
      return { ok: false, reason: "unknown_environment" };
    }

    if (
      this.#template(environment.templateId) !== undefined &&
      (update.isolation !== undefined ||
        update.image !== undefined ||
        update.setupScript !== undefined)
    ) {
      return { ok: false, reason: "from_template" };
    }

    const secrets = Object.fromEntries(
      Object.entries({ ...environment.secrets, ...update.secrets }).filter(
        (entry): entry is [string, string] => entry[1] !== null,
      ),
    );

    this.#store.updateEnvironment({
      ...environment,
      name: update.name ?? environment.name,
      isolation: update.isolation ?? environment.isolation,
      image: update.image === undefined ? environment.image : update.image,
      setupScript: update.setupScript ?? environment.setupScript,
      variables: update.variables ?? environment.variables,
      secrets,
    });

    const updated = this.list().find((each) => each.id === id);

    return updated
      ? { ok: true, value: updated }
      : { ok: false, reason: "unknown_environment" };
  }

  // Only once every Session in it is archived, so nothing still runs there.
  remove(
    id: string,
  ): Result<undefined, "unknown_environment" | "environment_in_use"> {
    if (this.get(id) === undefined) {
      return { ok: false, reason: "unknown_environment" };
    }

    if (this.#sessions().inUse(id)) {
      return { ok: false, reason: "environment_in_use" };
    }

    this.#store.deleteEnvironment(id);
    this.#sessions().removed();
    this.#changed();

    return { ok: true, value: undefined };
  }

  // A user sees the models plugins offer them, such as those their own
  // logins reach (ADR 0045).
  list(userId?: string): readonly Environment[] {
    const sessions = this.#sessions();

    return this.all().map((environment) => {
      const runners = this.#polls.runners(environment.provider);
      const offer = this.#offeredModels(environment, userId);
      const plugin = this.#startsRunners(environment);

      return {
        ...environment,
        ...this.#templated(environment),
        secrets: Object.keys(environment.secrets),
        online: runners.some(({ online }) => online),
        onDemand: plugin !== undefined,
        runnersFrom: plugin ?? null,
        runners: runners.map(({ name, online, capacity }) => ({
          name,
          online,
          capacity,
          running: sessions.running(environment.provider, name),
        })),
        folders: [
          ...new Set(runners.flatMap(({ inventory }) => inventory.folders)),
        ],
        reaches: reachesOf(runners),
        models: uniqueModels([
          ...offer.models,
          ...runners
            .filter(({ online }) => online)
            .flatMap(({ inventory }) => inventory.models),
          ...this.#store.registeredModels(environment.provider),
        ]),
        hiddenModels: offer.hidden ?? [],
        unavailableModels: offer.unavailable ?? [],
      };
    });
  }

  // What a Session's runner sets up for it.
  sessionEnvironment(id: string): SessionEnvironment {
    const environment = this.get(id);
    const template = this.#template(environment?.templateId ?? null);
    const own = environment && this.#templated(environment);

    return {
      isolation: own?.isolation ?? "process",
      image: own?.image ?? null,
      setupScript: own?.setupScript ?? "",
      variables: {
        ...template?.variables,
        ...environment?.variables,
        ...environment?.secrets,
      },
    };
  }

  #template(id: string | null): EnvironmentTemplate | undefined {
    return id === null
      ? undefined
      : this.#templates().find((each) => each.id === id);
  }

  // An Environment made from a template runs as the template says, and with
  // the defaults once its template is gone.
  #templated(
    environment: StoredEnvironment,
  ): Pick<Environment, "isolation" | "image" | "setupScript"> {
    const { isolation, image, setupScript } =
      this.#template(environment.templateId) ?? environment;

    return { isolation, image, setupScript };
  }

  // A runner's poll for work, until the returned function ends it. What it
  // reports of its models is written only when it changes, since runners
  // poll all the time.
  beginPoll(
    runner: { readonly name: string; readonly environment: string },
    poll: {
      readonly capacity: number | null;
      readonly inventory: Inventory;
      readonly registeredModels?: readonly ModelInfo[] | undefined;
    },
  ): () => void {
    // A runner's Environment is made before it gets a token, except the
    // built-in runner's, which waits for the first person (ADR 0049).
    const known = this.all().some(
      ({ provider }) => provider === runner.environment,
    );

    if (known && poll.registeredModels !== undefined) {
      this.#rememberModels(runner, poll.registeredModels);
    }

    return this.#polls.begin(runner.name, {
      environment: runner.environment,
      capacity: poll.capacity,
      inventory: poll.inventory,
    });
  }

  #rememberModels(
    runner: { readonly name: string; readonly environment: string },
    models: readonly ModelInfo[],
  ): void {
    const key = JSON.stringify(models);
    const reporter = JSON.stringify([runner.environment, runner.name]);
    if (this.#reported.get(reporter) === key) {
      return;
    }

    this.#reported.set(reporter, key);
    this.#store.setRegisteredModels(runner.environment, runner.name, models);
    this.#changed();
  }

  async waitForWork(
    provider: string,
    runner: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#polls.waitForWork(provider, runner, signal);
  }

  wake(provider: string): void {
    this.#polls.wake(provider);
  }

  // The runners that polled for the Environment since the server started.
  runners(provider: string): readonly PolledRunner[] {
    return this.#polls.runners(provider);
  }

  online(provider: string, runner: string): boolean {
    return this.#polls.online(provider, runner);
  }

  leaseLapsed(provider: string, runner: string): boolean {
    return this.#polls.leaseLapsed(provider, runner);
  }

  // Whether one of the Environment's runners reached every private host the
  // Workspace's repositories are on (ADR 0080).
  reaches(provider: string, workspace: Workspace | WorkspaceRequest): boolean {
    return this.#reachedBy(this.#polls.runners(provider), workspace);
  }

  #reachedBy(
    runners: readonly PolledRunner[],
    workspace: Workspace | WorkspaceRequest,
  ): boolean {
    return repositoryHostsOf(workspace)
      .filter((host) => this.#privateHost(host))
      .every((host) =>
        runners.some(({ inventory }) =>
          (inventory.reach ?? []).some(
            (each) => each.reached && each.host === host,
          ),
        ),
      );
  }

  // A runner started for one Session takes only that Session, and that
  // Session goes only to such a runner while one is known.
  mayTake(provider: string, session: Placeable, runner: string): boolean {
    const pool = this.#pool(provider);

    const dedicated = pool.runners.find(({ name }) => name === runner)
      ?.inventory.session;

    if (dedicated !== undefined) {
      return dedicated === session.id;
    }

    return (
      !pool.runners.some(({ inventory }) => inventory.session === session.id) &&
      this.#reachedBy(
        pool.runners.filter(({ name }) => name === runner),
        session.workspace,
      ) &&
      placesOn(session, runner, pool)
    );
  }

  // Whether a runner that hasn't joined the pool yet could take a Session
  // that hasn't run.
  placesOnNewRunner(provider: string, session: Placeable): boolean {
    return placesOnNewRunner(session, this.#pool(provider));
  }

  #pool(provider: string): Parameters<typeof placesOn>[2] {
    return {
      runners: this.#polls.runners(provider),
      leaseLapsed: (name) => this.#polls.leaseLapsed(provider, name),
    };
  }

  close(): void {
    this.#polls.close();
  }
}

function reachesOf(runners: readonly PolledRunner[]): ReachedHost[] {
  const found = new Map<string, ReachedHost>();

  for (const each of runners.flatMap(
    ({ inventory }) => inventory.reach ?? [],
  )) {
    const key = `${each.host}:${String(each.port)}`;

    found.set(key, {
      ...each,
      reached: each.reached || found.get(key)?.reached === true,
    });
  }

  return [...found.values()];
}

function repositoryHostsOf(
  workspace: Workspace | WorkspaceRequest,
): readonly string[] {
  const repositories = (): readonly string[] => {
    switch (workspace.kind) {
      case "clone":
        return [workspace.repository];
      case "repositories":
        return workspace.repositories.map(({ repository }) => repository);
      case "folder":
      case "worktree":
        return [];
    }
  };

  return repositories().flatMap((repository) => {
    const host = repositoryHost(repository);

    return host === undefined ? [] : [host];
  });
}
