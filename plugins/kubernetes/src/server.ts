import { randomBytes } from "node:crypto";
import {
  defineServer,
  HttpError,
  NotFound,
  type Runners,
  type RunnerSource,
  type ServerContext,
  StringEnum,
  Type,
} from "@pipoca/plugins";
import { type Environment, movable } from "@pipoca/protocol";
import { kubernetes } from "../plugin";
import {
  type Cluster,
  clusterAt,
  type RunnerPod,
  inClusterApi,
} from "./cluster";
import { type FailedPod, PodFailures } from "./failures";
import { runnerPod, sessionClaim, sessionPodName } from "./pods";
import {
  defaultSettings,
  type KubernetesEnvironment,
  type KubernetesSettings,
  workspaces,
} from "./settings";

type Context = ServerContext<typeof kubernetes>;

const positive = (fallback: number) =>
  Type.Integer({
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
    default: fallback,
  });

const podSettings = Type.Object({
  workspace: StringEnum(workspaces, { default: defaultSettings.workspace }),
  capacity: positive(defaultSettings.capacity),
  maxPods: positive(defaultSettings.maxPods),
  idleSeconds: positive(defaultSettings.idleSeconds),
  claimSize: Type.String({
    pattern: "^\\d+(Ki|Mi|Gi|Ti)$",
    default: defaultSettings.claimSize,
  }),
  storageClass: Type.Union([Type.String(), Type.Null()], {
    default: defaultSettings.storageClass,
  }),
  labels: Type.Record(Type.String(), Type.String(), { default: {} }),
  annotations: Type.Record(Type.String(), Type.String(), { default: {} }),
  podPatch: Type.Record(Type.String(), Type.Unknown(), { default: {} }),
});

// Null settings stop runner pods in the Environment. A setting left out
// takes its default.
const settingsChange = Type.Object({
  settings: Type.Union([
    Type.Record(Type.String(), Type.Unknown()),
    Type.Null(),
  ]),
});

const intervalMs = 2000;

// How long an Environment waits for a new pod after one fails, doubling with
// each failure in a row.
const retryAfterMs = 10_000;

interface Pods {
  readonly runners: Runners;
  readonly cluster: Cluster;
  readonly image: string;
  readonly imagePullPolicy: string | undefined;
  readonly server: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly imageId: () => Promise<string | undefined>;
  // Pods made before the server started may have stopped while it was down.
  readonly since: number;
}

const finished = new Set(["Succeeded", "Failed"]);

// Longer than pulling a large image takes.
const stuckAfterMs = 10 * 60_000;

// Starts runner pods for the Sessions of a Kubernetes Environment that no
// runner can take, and removes the pods that stopped (ADR 0032). The chart
// sets the cluster, image and the runners' URL in its environment.
export const server = defineServer(kubernetes, (context) => {
  const { clock, env, environments, log, provide, routes, schedule } = context;
  const api = inClusterApi(env);
  const image = env("PIPOCA_IMAGE");
  const imagePullPolicy = env("PIPOCA_IMAGE_PULL_POLICY");
  const runnerUrl = env("PIPOCA_RUNNER_URL");
  const pod = env("POD_NAME") ?? env("HOSTNAME");
  const faux = env("PIPOCA_FAUX_REPLY");
  const failures = new PodFailures(retryAfterMs);

  const startsPods =
    api !== undefined && image !== undefined && runnerUrl !== undefined;

  // Pod settings live in their template's entry in pipoca.json (ADR 0049).
  const byTemplate = environments.templateConfig(podSettings);

  const template = (id: string | null) =>
    environments.templates().find((each) => each.id === id);

  // An Environment starts pods as its template says, and none once its
  // template is gone (ADR 0049).
  const settingsOf: Settings = (environment) =>
    environment.templateId === null ||
    template(environment.templateId) === undefined
      ? undefined
      : byTemplate.get(environment.templateId);

  const answer = (
    settings: KubernetesSettings | undefined,
    editable: boolean,
    environmentId?: string,
  ): KubernetesEnvironment => ({
    settings: settings ?? null,
    startsPods,
    lastFailure:
      environmentId === undefined ? null : failures.last(environmentId),
    editable,
  });

  routes.get("templates/:id", { auth: "person" }, ({ caller, params }) => {
    if (template(params.id) === undefined) {
      throw new NotFound(`no template ${params.id}`);
    }

    return answer(byTemplate.get(params.id), caller.person.admin);
  });

  // A pod patch can mount the namespace's Secrets or run privileged, so it
  // is as much as the server's own access (ADR 0038).
  routes.post(
    "templates/:id",
    { auth: "admin", body: settingsChange },
    ({ params: { id }, body }) => {
      const found = template(id);

      if (found === undefined) {
        throw new NotFound(`no template ${id}`);
      }

      if (body.settings !== null && found.isolation !== "process") {
        throw new HttpError(409, "runner pods run Sessions as processes");
      }

      const settings = byTemplate.set(id, body.settings);

      for (const environment of environments.list()) {
        if (environment.templateId === id) {
          failures.clearEnvironment(environment.id);
        }
      }

      log("kubernetes template settings saved", {
        templateId: id,
        on: settings !== undefined,
      });

      return answer(settings, true);
    },
  );

  routes.get("environments/:id", { auth: "person" }, ({ caller, params }) => {
    const environment = environments.get(params.id);

    if (
      environment === undefined ||
      (environment.ownerId !== caller.person.id && !caller.person.admin)
    ) {
      throw new NotFound(`no Environment ${params.id}`);
    }

    return answer(settingsOf(environment), false, environment.id);
  });

  const runners = provide.runners({
    kind: {
      label: "Kubernetes",
      icon: "cloud",
      choice: "A pod for each person",
    },
    starts: (environment) =>
      startsPods && settingsOf(environment) !== undefined,
    replacesServerRunner: startsPods,
  });

  if (api === undefined || image === undefined || runnerUrl === undefined) {
    log("kubernetes runner pods off", {
      inCluster: api !== undefined,
      image: image !== undefined,
      server: runnerUrl !== undefined,
    });

    return;
  }

  const cluster = clusterAt(api, clock.now);
  let imageId: string | undefined;

  const pods: Pods = {
    runners,
    cluster,
    image,
    imagePullPolicy,
    server: runnerUrl,
    // Tests run the binary on Pi's faux model, in pods too.
    variables: faux === undefined ? {} : { PIPOCA_FAUX_REPLY: faux },
    imageId: async () => {
      if (imageId === undefined && pod !== undefined) {
        imageId = await cluster.imageId(pod, image).catch(() => undefined);
      }

      return imageId;
    },
    since: clock.now(),
  };

  schedule.every("reconcile", intervalMs, async () => {
    await reconcile(context, pods, settingsOf, failures).catch(
      (error: unknown) => {
        log("kubernetes runner pods not reconciled", { error: String(error) });
      },
    );
  });
});

type Settings = (environment: RunnerSource) => KubernetesSettings | undefined;

async function reconcile(
  context: Context,
  pods: Pods,
  settingsOf: Settings,
  failures: PodFailures,
): Promise<void> {
  const environments = context.environments.list();
  const all = await pods.cluster.runnerPods();
  const imageId = await pods.imageId();
  const now = context.clock.now();

  // Pods of an Environment without settings run until their agent stops.
  // Pods of an Environment this server doesn't know belong to another server
  // in the namespace.
  const removing: {
    readonly pod: RunnerPod;
    readonly reason: string;
    readonly problem: string | undefined;
  }[] = [];

  const failed: FailedPod[] = [];
  const outdated: RunnerPod[] = [];

  for (const pod of all) {
    const environment = environments.find(({ id }) => id === pod.environmentId);
    const reason = removalReason(pod, now);
    if (environment === undefined) {
      continue;
    }

    if (reason === undefined) {
      if (
        settingsOf(environment) !== undefined &&
        !pod.deleting &&
        !sameBinary(pod, pods.image, imageId)
      ) {
        outdated.push(pod);
      }

      continue;
    }

    const joined =
      pod.createdAt < pods.since ||
      environment.runners.some(({ name }) => name === pod.name);

    const problem = failureOf(pod, reason, joined, pods.server);
    removing.push({ pod, reason, problem });

    if (problem !== undefined) {
      failed.push({
        key: failureKey(pod),
        environmentId: pod.environmentId,
        pod: pod.name,
        problem,
      });
    }
  }

  // Before any delete, so no pod is gone while its failure is unknown.
  failures.record(failed, now);

  const removed = new Set(removing.map(({ pod }) => pod.name));

  for (const { pod, reason, problem } of removing) {
    pods.runners.revoke(pod.environmentId, pod.name);

    // One pod the API won't delete holds back no other Environment.
    try {
      await pods.cluster.deletePod(pod.name);
      await pods.cluster.deleteSecret(pod.name);
    } catch (error) {
      context.log("runner pod not removed", {
        environmentId: pod.environmentId,
        pod: pod.name,
        error: String(error),
      });

      continue;
    }

    context.log("runner pod removed", {
      environmentId: pod.environmentId,
      pod: pod.name,
      phase: pod.phase,
      reason,
      ...(problem !== undefined && { problem }),
    });
  }

  // After an upgrade a pod would run the old binary against the new server.
  // Deleting it gracefully lets its agent halt its Sessions first, and once
  // it is gone the pass below revokes its token, as for any pod deleted from
  // outside. A Session's claim stays, so its Session goes on in the new pod.
  for (const pod of outdated) {
    try {
      await pods.cluster.deletePod(pod.name);
    } catch (error) {
      context.log("runner pod not replaced", {
        environmentId: pod.environmentId,
        pod: pod.name,
        error: String(error),
      });

      continue;
    }

    context.log("runner pod replaced", {
      environmentId: pod.environmentId,
      pod: pod.name,
      binaryImage: pod.binaryImage,
      binaryImageId: pod.binaryImageId,
      image: pods.image,
      imageId,
    });
  }

  // A pod deleted from outside leaves its Secret, and its token valid.
  for (const secret of await pods.cluster.runnerSecrets()) {
    const known = environments.some(({ id }) => id === secret.environmentId);
    if (!known || all.some(({ name }) => name === secret.name)) {
      continue;
    }

    pods.runners.revoke(secret.environmentId, secret.name);
    await pods.cluster.deleteSecret(secret.name);

    context.log("runner secret removed", {
      environmentId: secret.environmentId,
      secret: secret.name,
    });
  }

  // An archived Session's workspace is removed, as on any runner, so its
  // claim goes once no pod mounts it. A workspace its runner kept, or hasn't
  // checked yet, stays until removed or forced, as on any runner.
  for (const claim of await pods.cluster.sessionClaims()) {
    const mounted = all.some(
      ({ name }) => name === claim.name && !removed.has(name),
    );

    const session = context.sessions.get(claim.sessionId);
    if (
      !mounted &&
      session !== undefined &&
      session.archivedAt !== null &&
      session.workspaceRemoval !== "kept" &&
      session.workspaceRemoval !== "pending"
    ) {
      try {
        await pods.cluster.deleteClaim(claim.name);
      } catch (error) {
        context.log("session claim not removed", {
          sessionId: claim.sessionId,
          claim: claim.name,
          error: String(error),
        });

        continue;
      }

      context.log("session claim removed", {
        sessionId: claim.sessionId,
        claim: claim.name,
      });
    }
  }

  const owners = new Map(environments.map(({ id, ownerId }) => [id, ownerId]));
  const perPerson = context.config.get().maxPodsPerPerson;
  const running = new Map<string, number>();

  for (const pod of all) {
    const owner = owners.get(pod.environmentId);
    if (owner !== undefined && !finished.has(pod.phase)) {
      running.set(owner, (running.get(owner) ?? 0) + 1);
    }
  }

  for (const environment of environments) {
    const environmentId = environment.id;
    const settings = settingsOf(environment);
    if (settings === undefined) {
      continue;
    }

    const active = all.filter(
      (pod) => pod.environmentId === environmentId && !finished.has(pod.phase),
    );

    const owned = running.get(environment.ownerId) ?? 0;
    const room = Math.min(settings.maxPods - active.length, perPerson - owned);

    for (const pod of active) {
      const online = environment.runners.some(
        (runner) => runner.online && runner.name === pod.name,
      );

      if (online && !removed.has(pod.name)) {
        failures.clear(failureKey(pod));
      }
    }

    const waiting = (key: string): boolean => failures.waiting(key, now);

    const started = await scale(
      context,
      pods,
      environment,
      settings,
      active,
      room,
      waiting,
    ).catch((error: unknown) => {
      context.log("kubernetes runner pods not started", {
        environmentId,
        error: String(error),
      });

      return 0;
    });

    running.set(environment.ownerId, owned + started);
  }
}

async function scale(
  context: Context,
  pods: Pods,
  environment: Environment,
  settings: KubernetesSettings,
  active: readonly RunnerPod[],
  room: number,
  waiting: (key: string) => boolean,
): Promise<number> {
  const environmentId = environment.id;

  // The agent in a pod runs Sessions as processes; it has no Docker.
  if (environment.isolation !== "process") {
    return 0;
  }

  if (settings.workspace === "claim") {
    return scaleSessions(
      context,
      pods,
      environment,
      settings,
      active,
      room,
      waiting,
    );
  }

  if (waiting(environmentId)) {
    return 0;
  }

  const online = new Set(
    environment.runners.filter((r) => r.online).map(({ name }) => name),
  );

  // A pod that hasn't polled yet takes Sessions once it does. A Session held
  // by a runner that went away moves to a pod only if its Workspace can be
  // made again there.
  const joining = active.filter(({ name }) => !online.has(name)).length;

  const unplaced = pods.runners
    .unplaced(environmentId)
    .filter(
      (session) => session.runner === null || movable(session.workspace),
    ).length;

  const wanted = Math.ceil(
    Math.max(0, unplaced - joining * settings.capacity) / settings.capacity,
  );

  const starting = Math.max(0, Math.min(wanted, room));

  for (let i = 0; i < starting; i++) {
    const name = `pi-runner-${randomBytes(4).toString("hex")}`;
    await startPod(pods, environment, settings, name);
    context.log("runner pod started", { environmentId, pod: name, unplaced });
  }

  return starting;
}

// A Session's own pod takes only that Session, and a pod of that name, on the
// same claim, takes it back after the pod stops or is deleted (ADR 0032).
async function scaleSessions(
  context: Context,
  pods: Pods,
  environment: Environment,
  settings: KubernetesSettings,
  active: readonly RunnerPod[],
  room: number,
  waiting: (key: string) => boolean,
): Promise<number> {
  const running = new Set(active.map(({ name }) => name));
  let started = 0;

  for (const session of pods.runners.unplaced(environment.id)) {
    const name = sessionPodName(session.id);
    if (running.has(name) || started >= room || waiting(name)) {
      continue;
    }

    await pods.cluster.createClaim(
      sessionClaim(session.id, environment.id, settings),
    );

    await startPod(pods, environment, settings, name, session.id);
    started++;

    context.log("session pod started", {
      environmentId: environment.id,
      sessionId: session.id,
      pod: name,
    });
  }

  return started;
}

async function startPod(
  {
    runners,
    cluster,
    image,
    imagePullPolicy,
    server: serverUrl,
    variables,
  }: Pods,
  environment: Environment,
  settings: KubernetesSettings,
  name: string,
  sessionId?: string,
): Promise<void> {
  // A pod deleted from outside leaves its Secret behind.
  await cluster.deleteSecret(name);

  await cluster.createSecret(name, environment.id, {
    token: runners.token(environment.id, name),
  });

  try {
    await cluster.createPod(
      runnerPod({
        name,
        environmentId: environment.id,
        image: environment.image ?? image,
        binaryImage: image,
        binaryPullPolicy: imagePullPolicy,
        server: serverUrl,
        variables,
        settings,
        ...(sessionId !== undefined && { sessionId }),
      }),
    );
  } catch (error) {
    runners.revoke(environment.id, name);
    await cluster.deleteSecret(name);
    throw error;
  }
}

// A Session's own pod backs off alone; an Environment's shared pods together.
function failureKey(pod: RunnerPod): string {
  return pod.sessionId === undefined ? pod.environmentId : pod.name;
}

// A pod that stopped before its agent ever polled failed as surely as one
// whose agent crashed: the server never got a runner out of it.
function failureOf(
  pod: RunnerPod,
  reason: string,
  joined: boolean,
  serverUrl: string,
): string | undefined {
  if (reason === "never started") {
    return pod.problem ?? "it didn't start in 10 minutes";
  }

  if (pod.phase === "Failed") {
    return pod.problem ?? "its agent failed";
  }

  return joined
    ? undefined
    : `its agent never reached the server at ${serverUrl}`;
}

// The digests the nodes ran decide. Until both are known, as for a pod
// still pending or a server outside a pod, the names in the specs do.
function sameBinary(
  pod: RunnerPod,
  image: string,
  imageId: string | undefined,
): boolean {
  if (pod.binaryImage === undefined) {
    return true;
  }

  const ran = digestOf(pod.binaryImageId);
  const runs = digestOf(imageId);
  if (ran !== undefined && runs !== undefined) {
    return ran === runs;
  }

  const named = digestOf(pod.binaryImage);
  const names = digestOf(image);

  return named !== undefined && names !== undefined
    ? named === names
    : pod.binaryImage === image;
}

// An image ID such as repo@sha256:..., with a runtime's prefix or none.
function digestOf(image: string | undefined): string | undefined {
  const digest = image?.slice(image.lastIndexOf("@") + 1);

  return digest?.startsWith("sha256:") === true ? digest : undefined;
}

function removalReason(pod: RunnerPod, now: number): string | undefined {
  if (finished.has(pod.phase)) {
    return "stopped";
  }

  if (pod.phase !== "Running" && now - pod.createdAt > stuckAfterMs) {
    return "never started";
  }

  return undefined;
}
