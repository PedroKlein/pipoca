import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Environment,
  type EnvironmentTemplate,
  type ListedTemplate,
  type Method,
  protocolVersion,
  type Session,
  versionHeader,
  type Work,
} from "@pipoca/protocol";
import {
  type PluginTest,
  testPlugin,
  type TestPluginOptions,
} from "@pipoca/testing";
import { server } from "./server";

interface FakePod {
  readonly metadata: {
    readonly name: string;
    readonly labels: Record<string, string>;
    creationTimestamp?: string;
  };
  readonly spec: {
    readonly containers: readonly {
      readonly image: string;
      readonly command: readonly string[];
    }[];
    readonly [field: string]: unknown;
  };
  status?: {
    phase: string;
    containerStatuses?: readonly object[];
    initContainerStatuses?: readonly object[];
  };
}

interface Labelled {
  readonly metadata: { readonly labels: Record<string, string> };
}

interface FakeSecret extends Labelled {
  readonly stringData: Record<string, string>;
}

// The pod, Secret and claim calls of the Kubernetes API, in memory.
function fakeApi(): {
  readonly pods: Map<string, FakePod>;
  readonly secrets: Map<string, FakeSecret>;
  readonly claims: Map<string, Labelled>;
  // Objects whose delete fails, as on an API server that is down for them.
  readonly undeletable: Set<string>;
  readonly fetch: (request: Request) => Promise<Response>;
} {
  const pods = new Map<string, FakePod>();
  const secrets = new Map<string, FakeSecret>();
  const claims = new Map<string, Labelled>();
  const undeletable = new Set<string>();
  const prefix = "https://kubernetes.test/api/v1/namespaces/pi/";

  const stores: Record<string, Map<string, unknown>> = {
    pods,
    secrets,
    persistentvolumeclaims: claims,
  };

  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (!request.url.startsWith(prefix)) {
      return Response.json({}, { status: 404 });
    }

    const [kind = "", name] = url.pathname
      .slice(new URL(prefix).pathname.length)
      .split("/");

    const store = stores[kind];

    if (store === undefined) {
      return Response.json({}, { status: 404 });
    }

    if (request.method === "GET" && name !== undefined) {
      const found = store.get(name);

      return found === undefined
        ? Response.json({}, { status: 404 })
        : Response.json(found);
    }

    if (request.method === "GET") {
      const selector = url.searchParams.get("labelSelector") ?? "";
      const [label = "", value] = selector.split("=");

      return Response.json({
        items: [...(store as Map<string, Labelled>).values()].filter(
          ({ metadata }) =>
            value === undefined
              ? label in metadata.labels
              : metadata.labels[label] === value,
        ),
      });
    }

    if (request.method === "POST") {
      const body = (await request.json()) as { metadata: { name: string } };

      if (store.has(body.metadata.name)) {
        return Response.json({}, { status: 409 });
      }

      store.set(body.metadata.name, body);

      return Response.json(body, { status: 201 });
    }

    if (request.method === "DELETE" && undeletable.has(name ?? "")) {
      return Response.json({}, { status: 500 });
    }

    if (request.method === "DELETE" && name !== undefined) {
      return store.delete(name)
        ? Response.json({})
        : Response.json({}, { status: 404 });
    }

    return Response.json({}, { status: 405 });
  };

  return { pods, secrets, claims, undeletable, fetch };
}

const people = [
  { id: "ana", name: "Ana", admin: true },
  { id: "bo", name: "Bo" },
];

// What the chart gives the server's pod.
const cluster = {
  KUBERNETES_SERVICE_HOST: "kubernetes.test",
  KUBERNETES_SERVICE_PORT: "443",
  PIPOCA_IMAGE: "pipoca:test",
  PIPOCA_IMAGE_PULL_POLICY: "Always",
  PIPOCA_RUNNER_URL: "http://pipoca:7420",
  POD_NAME: "pipoca-server",
};

const runnerUrl = cluster.PIPOCA_RUNNER_URL;
const passMs = 2000;
const retryMs = 10_000;
let env: Readonly<Record<string, string>>;

let root: string;
let api: ReturnType<typeof fakeApi>;
let t: PluginTest;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pipoca-k8s-")));
  const account = join(root, "serviceaccount");

  await mkdir(account);
  await writeFile(join(account, "namespace"), "pi");
  await writeFile(join(account, "ca.crt"), "ca");
  await writeFile(join(account, "token"), "t");

  env = { ...cluster, PIPOCA_SERVICE_ACCOUNT_DIR: account };
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function start(
  o: Omit<TestPluginOptions<typeof server.plugin>, "people" | "fetch"> = {},
): Promise<void> {
  t = await testPlugin(server, { people, fetch: api.fetch, env, ...o });
}

beforeEach(async () => {
  api = fakeApi();
  await start();
});

afterEach(async () => {
  await t.close();
});

async function json<T>(response: Promise<Response>): Promise<T> {
  const answered = await response;

  if (!answered.ok) {
    throw new Error(`${String(answered.status)}: ${await answered.text()}`);
  }

  return (await answered.json()) as T;
}

async function kernel<T>(
  path: string,
  body?: unknown,
  method?: Method,
): Promise<T> {
  return json<T>(
    t.as("ana").raw(path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
  );
}

// Reconcile passes, as the plugin's schedule runs them.
async function pass(times = 1): Promise<void> {
  for (let each = 0; each < times; each++) {
    await t.clock.advance(passMs);
  }
}

// Passes until the condition holds, and how long that took.
async function passUntil(done: () => boolean): Promise<number> {
  const from = t.clock.now();

  for (let each = 0; each < 100 && !done(); each++) {
    await pass();
  }

  expect(done()).toBe(true);

  return t.clock.now() - from;
}

async function postSettings(
  templateId: string | null,
  body: unknown,
  as = "ana",
): Promise<Response> {
  return t.as(as).raw(`templates/${templateId ?? ""}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// An Environment made from a new pod template.
async function kubernetesEnvironment(
  settings: object,
  name = "pods",
): Promise<Environment> {
  const template = await kernel<EnvironmentTemplate>(
    "/api/environment-templates",
    { name },
  );

  expect((await postSettings(template.id, { settings })).status).toBe(200);

  return kernel<Environment>("/api/environments", {
    name,
    template: template.id,
  });
}

async function startSession(
  environment: Environment,
  workspace: object = { kind: "folder", path: root },
): Promise<Session> {
  return kernel<Session>("/api/sessions", {
    environment: environment.id,
    workspace,
  });
}

async function sessionOf(id: string): Promise<Session> {
  return kernel<Session>(`/api/sessions/${id}`);
}

async function environments(): Promise<readonly Environment[]> {
  return kernel<Environment[]>("/api/environments");
}

async function shown(environment: Environment): Promise<{
  readonly settings: unknown;
  readonly editable: boolean;
  readonly lastFailure: { readonly problem: string } | null;
}> {
  return t.as("ana").get(`environments/${environment.id}`);
}

const tokenOf = (pod: string): string =>
  api.secrets.get(pod)?.stringData["token"] ?? "";

// A runner's poll, as the agent in a pod sends it.
async function poll(token: string, body: object = {}): Promise<Response> {
  return t.as("ana").raw("/runner/work", {
    method: "POST",
    body: JSON.stringify({ running: [], folders: [], models: [], ...body }),
    headers: {
      authorization: `Bearer ${token}`,
      [versionHeader]: String(protocolVersion),
    },
  });
}

function failAll(): void {
  for (const pod of api.pods.values()) {
    pod.status = { phase: "Failed" };
  }
}

const fromKubernetes = {
  plugin: "kubernetes",
  label: "Kubernetes",
  icon: "cloud",
};

test("reads an Environment that starts runner pods as on demand, from Kubernetes", async () => {
  const plain = await kernel<Environment>("/api/environments", {
    name: "plain",
  });

  const pods = await kubernetesEnvironment({ capacity: 1, maxPods: 2 });
  const listed = await environments();

  expect(listed.find(({ id }) => id === pods.id)).toMatchObject({
    online: false,
    onDemand: true,
    runnersFrom: fromKubernetes,
  });

  expect(listed.find(({ id }) => id === plain.id)).toMatchObject({
    onDemand: false,
    runnersFrom: null,
  });

  await postSettings(pods.templateId, { settings: null });

  expect((await environments()).find(({ id }) => id === pods.id)).toMatchObject(
    { onDemand: false, runnersFrom: null },
  );
});

test("says which templates have runner pods started for them", async () => {
  const plain = await kernel<EnvironmentTemplate>(
    "/api/environment-templates",
    { name: "plain" },
  );

  const pods = await kubernetesEnvironment({ capacity: 1, maxPods: 2 });

  const listed = await kernel<ListedTemplate[]>("/api/environment-templates");

  expect(listed.find(({ id }) => id === pods.templateId)?.runnersFrom).toEqual(
    fromKubernetes,
  );

  expect(listed.find(({ id }) => id === plain.id)?.runnersFrom).toBeNull();
});

test("starts no more runner pods for one person than the per-person limit, across their Environments", async () => {
  await t.close();
  await start({ config: { maxPodsPerPerson: 3 } });

  const first = await kubernetesEnvironment({ capacity: 1, maxPods: 2 });

  const second = await kubernetesEnvironment(
    { capacity: 1, maxPods: 2 },
    "more-pods",
  );

  for (const environment of [first, second, first, second]) {
    await startSession(environment);
  }

  await pass(3);

  expect(api.pods.size).toBe(3);
});

test("starts one runner pod per Session no runner can take, up to the most allowed", async () => {
  const environment = await kubernetesEnvironment({ capacity: 1, maxPods: 2 });

  await startSession(environment);
  await pass(2);

  expect(api.pods.size).toBe(1);

  await startSession(environment);
  await startSession(environment);
  await pass(2);

  const [pod] = api.pods.values();

  expect(api.pods.size).toBe(2);
  expect([...api.secrets.keys()].sort()).toEqual([...api.pods.keys()].sort());
  expect(pod?.metadata.labels["pipoca.dev/environment"]).toBe(environment.id);

  expect(
    api.secrets.get(pod?.metadata.name ?? "")?.metadata.labels[
      "pipoca.dev/environment"
    ],
  ).toBe(environment.id);

  expect(pod?.spec.containers[0]).toMatchObject({
    image: "pipoca:test",
    command: [
      "/pipoca/pipoca",
      "agent",
      "--name",
      pod?.metadata.name,
      "--server",
      runnerUrl,
      "--capacity",
      "1",
      "--exit-when-idle",
      "300",
    ],
  });
});

test("lets the runner in a started pod take the Session, and forgets an earlier failed pod once it joins", async () => {
  const environment = await kubernetesEnvironment({});
  const session = await startSession(environment);
  await pass();

  const [failed] = api.pods.values();

  if (failed) {
    failed.status = { phase: "Failed" };
  }

  await pass();
  const afterFailure = (await shown(environment)).lastFailure;
  await passUntil(() => api.pods.size === 1);

  const [name = ""] = api.pods.keys();
  const token = tokenOf(name);
  const work = await json<Work>(poll(token));
  await pass();
  const whileRunning = (await shown(environment)).lastFailure;

  const pod = api.pods.get(name);

  if (pod) {
    pod.status = { phase: "Succeeded" };
  }

  await pass();

  expect({
    afterFailure: afterFailure?.problem,
    took: work.start.map(({ sessionId }) => sessionId),
    runner: (await sessionOf(session.id)).runner,
    whileRunning,
    afterStop: (await shown(environment)).lastFailure,
    pods: api.pods.size,
    secrets: api.secrets.size,
    revoked: (await poll(token)).status,
  }).toEqual({
    afterFailure: "its agent failed",
    took: [session.id],
    runner: name,
    whileRunning: null,
    afterStop: null,
    pods: 0,
    secrets: 0,
    revoked: 401,
  });
});

test("reads a template's pod settings from its entry in pipoca.json, and saves them there", async () => {
  await t.close();

  await start({
    kernelConfig: {
      templates: [
        { id: "pods", name: "Pods", kubernetes: { capacity: 2, maxPods: 3 } },
        { id: "broken", name: "Broken", kubernetes: { capacity: "two" } },
      ],
    },
  });

  const read = async (id: string): Promise<unknown> =>
    (await t.as("ana").get<{ settings: unknown }>(`templates/${id}`)).settings;

  expect(await read("pods")).toEqual({
    workspace: "pod",
    capacity: 2,
    maxPods: 3,
    idleSeconds: 300,
    claimSize: "10Gi",
    storageClass: null,
    podPatch: {},
  });

  expect(await read("broken")).toBeNull();

  expect(
    t.log.some(
      ({ message, fields }) =>
        message === "template config doesn't fit" &&
        (fields as { templateId?: string }).templateId === "broken",
    ),
  ).toBe(true);

  await postSettings("pods", { settings: { capacity: 4 } });

  await kernel(
    "/api/environment-templates/pods",
    { name: "Bigger pods" },
    "PATCH",
  );

  await t.restart();

  expect(await read("pods")).toMatchObject({ capacity: 4, maxPods: 5 });

  expect(
    (await kernel<ListedTemplate[]>("/api/environment-templates")).find(
      ({ id }) => id === "pods",
    )?.name,
  ).toBe("Bigger pods");

  await postSettings("pods", { settings: null });

  expect(await read("pods")).toBeNull();
});

test("refuses Kubernetes settings it can't use, and changes from anyone but admins", async () => {
  const template = await kernel<EnvironmentTemplate>(
    "/api/environment-templates",
    { name: "pods" },
  );

  const responses = await Promise.all([
    postSettings(template.id, { settings: { capacity: 0 } }),
    postSettings(template.id, { settings: { podPatch: [] } }),
    postSettings(template.id, { settings: { workspace: "disk" } }),
    postSettings(template.id, { settings: { claimSize: "lots" } }),
    postSettings(template.id, { capacity: 1 }),
    postSettings("nope", { settings: {} }),
    postSettings(template.id, { settings: {} }, "bo"),
  ]);

  const unsaved = await t.as("ana").get(`templates/${template.id}`);
  const forBo = await t.as("bo").get(`templates/${template.id}`);

  await kernel(
    `/api/environment-templates/${template.id}`,
    { isolation: "container" },
    "PATCH",
  );

  const inContainers = await postSettings(template.id, { settings: {} });

  expect(responses.map(({ status }) => status)).toEqual([
    422, 422, 422, 422, 422, 404, 403,
  ]);

  expect(unsaved).toEqual({
    settings: null,
    startsPods: true,
    lastFailure: null,
    editable: true,
  });

  expect(forBo).toMatchObject({ editable: false });
  expect(inContainers.status).toBe(409);
});

test("takes runner pods from a pod template, never from an Environment's own settings", async () => {
  const laptop = await kernel<Environment>("/api/environments", {
    name: "laptop",
  });

  const pods = await kubernetesEnvironment({ maxPods: 2 });

  expect(await shown(laptop)).toMatchObject({ settings: null });

  expect(await shown(pods)).toMatchObject({
    settings: { maxPods: 2 },
    editable: false,
  });

  await startSession(pods);
  await pass();

  expect(api.pods.size).toBe(1);
});

test("keeps a pod patch from giving runner pods a service account token", async () => {
  const environment = await kubernetesEnvironment({
    podPatch: {
      spec: {
        serviceAccountName: "pipoca",
        automountServiceAccountToken: true,
        nodeSelector: { pool: "agents" },
      },
    },
  });

  await startSession(environment);
  await pass();

  const [pod] = api.pods.values();

  expect(pod?.spec).toMatchObject({
    automountServiceAccountToken: false,
    nodeSelector: { pool: "agents" },
  });

  expect(pod?.spec["serviceAccountName"]).toBeUndefined();
});

test("copies the binary from the Pipoca image pulled as the server's own", async () => {
  const environment = await kubernetesEnvironment({});
  await startSession(environment);
  await pass();

  const [pod] = api.pods.values();

  expect(pod?.spec["initContainers"]).toMatchObject([
    { image: "pipoca:test", imagePullPolicy: "Always" },
  ]);
});

test("gives runner pods a home their user can write and leaves the mesh sidecar to the namespace", async () => {
  const environment = await kubernetesEnvironment({ workspace: "claim" });
  await startSession(environment);
  await pass();

  const [pod] = api.pods.values();

  expect(pod?.spec["securityContext"]).toEqual({ fsGroup: 1000 });
  expect(pod?.metadata.labels).not.toHaveProperty("sidecar.istio.io/inject");
});

test("removes a runner pod that never starts, and starts another", async () => {
  const environment = await kubernetesEnvironment({});
  await startSession(environment);
  await pass();

  const [first] = api.pods.values();

  if (first) {
    first.metadata.creationTimestamp = new Date(
      t.clock.now() - 60 * 60_000,
    ).toISOString();

    first.status = {
      phase: "Pending",
      containerStatuses: [
        {
          name: "runner",
          state: {
            waiting: {
              reason: "ImagePullBackOff",
              message: 'Back-off pulling image "nope:1"',
            },
          },
        },
      ],
    };
  }

  await passUntil(
    () => first !== undefined && !api.pods.has(first.metadata.name),
  );

  await passUntil(() => api.pods.size === 1);

  expect(api.secrets.size).toBe(1);

  expect((await shown(environment)).lastFailure?.problem).toBe(
    'runner is waiting: Back-off pulling image "nope:1"',
  );
});

test("waits longer for a new runner pod after each one that fails, and says why", async () => {
  const environment = await kubernetesEnvironment({});
  await startSession(environment);
  await pass();

  const fail = async (): Promise<number> => {
    const [pod] = api.pods.values();

    if (pod) {
      pod.status = {
        phase: "Failed",
        containerStatuses: [
          {
            name: "runner",
            state: {
              terminated: {
                exitCode: 1,
                message: "EACCES: permission denied, mkdir '/home/pi'",
              },
            },
          },
        ],
      };
    }

    await pass();

    expect(api.pods.size).toBe(0);

    return passUntil(() => api.pods.size === 1);
  };

  expect([await fail(), await fail()]).toEqual([retryMs, 2 * retryMs]);

  expect((await shown(environment)).lastFailure?.problem).toBe(
    "runner exited with 1: EACCES: permission denied, mkdir '/home/pi'",
  );
});

test("counts a runner pod whose agent never reached the server as failed", async () => {
  const environment = await kubernetesEnvironment({});
  await startSession(environment);
  await pass();

  const [pod] = api.pods.values();

  if (pod) {
    pod.status = { phase: "Succeeded" };
  }

  await pass();

  expect(api.pods.size).toBe(0);

  expect((await shown(environment)).lastFailure?.problem).toBe(
    `its agent never reached the server at ${runnerUrl}`,
  );
});

test("counts runner pods that fail together as one failure", async () => {
  const environment = await kubernetesEnvironment({ maxPods: 3 });

  for (const _ of [1, 2, 3]) {
    await startSession(environment);
  }

  await pass();

  expect(api.pods.size).toBe(3);

  failAll();
  await pass();

  expect(api.pods.size).toBe(0);
  expect(await passUntil(() => api.pods.size > 0)).toBe(retryMs);
});

test("holds back only the Session whose own pod failed", async () => {
  const environment = await kubernetesEnvironment({ workspace: "claim" });
  const first = await startSession(environment);
  await pass();

  failAll();
  await pass();

  expect(api.pods.size).toBe(0);

  const second = await startSession(environment);
  await pass();

  expect([...api.pods.keys()]).toEqual([`pi-session-${second.id}`]);
  expect(api.pods.has(`pi-session-${first.id}`)).toBe(false);
});

test("forgets a failure once the Environment's settings are saved again", async () => {
  const environment = await kubernetesEnvironment({});
  await startSession(environment);
  await pass();

  failAll();
  await pass();
  const failed = (await shown(environment)).lastFailure;

  await postSettings(environment.templateId, {
    settings: { idleSeconds: 120 },
  });

  expect(failed).not.toBeNull();
  expect((await shown(environment)).lastFailure).toBeNull();
});

test("doesn't count a pod made before the server started that never reached it", async () => {
  const environment = await kubernetesEnvironment({});

  api.pods.set("pi-runner-0ld", {
    metadata: {
      name: "pi-runner-0ld",
      labels: { "pipoca.dev/environment": environment.id },
      creationTimestamp: new Date(t.clock.now() - 60_000).toISOString(),
    },
    spec: { containers: [] },
    status: { phase: "Succeeded" },
  });

  await pass();

  expect(api.pods.has("pi-runner-0ld")).toBe(false);
  expect((await shown(environment)).lastFailure).toBeNull();
});

test("revokes the token of a runner pod deleted from outside, and deletes its Secret", async () => {
  const environment = await kubernetesEnvironment({});
  await startSession(environment);
  await pass();

  const [name = ""] = api.pods.keys();
  const token = tokenOf(name);
  api.pods.delete(name);
  await pass(2);

  expect(api.secrets.has(name)).toBe(false);
  expect((await poll(token)).status).toBe(401);
  expect([...api.secrets.keys()]).toEqual([...api.pods.keys()]);
  expect(api.pods.size).toBe(1);
});

test("keeps starting runner pods while one stopped pod can't be deleted", async () => {
  const environment = await kubernetesEnvironment({});

  api.undeletable.add("pi-runner-stuck");

  api.pods.set("pi-runner-stuck", {
    metadata: {
      name: "pi-runner-stuck",
      labels: { "pipoca.dev/environment": environment.id },
      creationTimestamp: new Date(t.clock.now() - 60_000).toISOString(),
    },
    spec: { containers: [] },
    status: { phase: "Succeeded" },
  });

  await pass();

  expect(
    t.log.some(
      ({ message, fields }) =>
        message === "runner pod not removed" &&
        (fields as { pod?: string }).pod === "pi-runner-stuck",
    ),
  ).toBe(true);

  await startSession(environment);
  await pass();

  expect(api.pods.size).toBe(2);
  expect(api.pods.has("pi-runner-stuck")).toBe(true);
});

test("removes stopped runner pods of an Environment whose settings were removed", async () => {
  const environment = await kubernetesEnvironment({});
  await startSession(environment);
  await pass();

  expect(api.pods.size).toBe(1);

  await postSettings(environment.templateId, { settings: null });

  const [pod] = api.pods.values();

  if (pod) {
    pod.status = { phase: "Succeeded" };
  }

  await pass();

  expect([api.pods.size, api.secrets.size]).toEqual([0, 0]);
});

test("reconciles saved settings once the server starts again", async () => {
  const environment = await kubernetesEnvironment({});
  await t.restart();

  await startSession(environment);
  await pass();

  expect(api.pods.size).toBe(1);

  expect(
    t.log.filter(({ message }) => message.includes("not reconciled")),
  ).toEqual([]);
});

test("gives each Session a pod of its own that mounts its claim, and brings it back once deleted", async () => {
  const environment = await kubernetesEnvironment({
    workspace: "claim",
    claimSize: "1Gi",
  });

  const first = await startSession(environment);
  const second = await startSession(environment);
  await pass();

  const name = `pi-session-${second.id}`;
  const pod = api.pods.get(name);
  const token = tokenOf(name);

  await json(poll(token, { session: second.id }));
  const heldFirst = await sessionOf(first.id);
  const heldSecond = await sessionOf(second.id);

  // Its agent goes with the pod, and the runner goes offline.
  api.pods.delete(name);
  await t.clock.advance("25d");

  expect(api.pods.has(name)).toBe(true);
  expect(tokenOf(name)).not.toBe(token);

  expect([...api.claims.keys()].sort()).toEqual(
    [`pi-session-${first.id}`, name].sort(),
  );

  expect(pod?.spec["volumes"]).toContainEqual({
    name: "home",
    persistentVolumeClaim: { claimName: name },
  });

  expect(pod?.spec.containers[0]?.command.slice(-6)).toEqual([
    "--capacity",
    "1",
    "--exit-when-idle",
    "300",
    "--session",
    second.id,
  ]);

  expect(heldFirst).toMatchObject({ runner: null, status: "queued" });
  expect(heldSecond).toMatchObject({ runner: name });

  await kernel(`/api/sessions/${second.id}`, { archived: true }, "PATCH");

  const back = api.pods.get(name);

  if (back) {
    back.status = { phase: "Succeeded" };
  }

  await pass();

  expect([api.claims.has(name), api.pods.has(name)]).toEqual([false, false]);
  expect(api.claims.has(`pi-session-${first.id}`)).toBe(true);
});

test("keeps an archived Session's claim while its workspace is kept, until forced", async () => {
  const environment = await kubernetesEnvironment({ workspace: "claim" });

  const session = await startSession(environment, {
    kind: "clone",
    repository: "https://example.com/r.git",
  });

  const name = `pi-session-${session.id}`;
  await pass();

  expect([api.pods.has(name), api.claims.has(name)]).toEqual([true, true]);

  const archived = await kernel<Session>(
    `/api/sessions/${session.id}`,
    { archived: true },
    "PATCH",
  );

  const reported = await t
    .as("ana")
    .raw(`/runner/sessions/${session.id}/workspace-removal`, {
      method: "POST",
      body: JSON.stringify({
        generation: archived.generation,
        outcome: "kept",
        reason: "uncommitted changes",
      }),
      headers: {
        authorization: `Bearer ${tokenOf(name)}`,
        [versionHeader]: String(protocolVersion),
      },
    });

  const pod = api.pods.get(name);

  if (pod) {
    pod.status = { phase: "Succeeded" };
  }

  await pass(2);

  expect(reported.status).toBe(204);
  expect(api.pods.has(name)).toBe(false);
  expect((await sessionOf(session.id)).workspaceRemoval).toBe("kept");
  expect(api.claims.has(name)).toBe(true);

  await t
    .as("ana")
    .raw(`/api/sessions/${session.id}/workspace`, { method: "DELETE" });

  await pass();

  expect(api.claims.has(name)).toBe(false);
});

test("replaces a runner pod whose spec names an older Pipoca image, keeping its claim", async () => {
  const environment = await kubernetesEnvironment({ workspace: "claim" });
  const old = await startSession(environment);
  const current = await startSession(environment);
  const oldName = `pi-session-${old.id}`;
  const currentName = `pi-session-${current.id}`;
  await pass();

  const oldToken = tokenOf(oldName);
  const currentToken = tokenOf(currentName);
  const currentPod = api.pods.get(currentName);
  const started = api.pods.get(oldName);

  const upgraded: FakePod = {
    metadata: started?.metadata ?? { name: oldName, labels: {} },
    spec: {
      ...started?.spec,
      containers: started?.spec.containers ?? [],
      initContainers: [{ name: "pipoca", image: "pipoca:old" }],
    },
    status: { phase: "Running" },
  };

  api.pods.set(oldName, upgraded);
  await pass(3);

  expect(api.pods.get(oldName)).not.toBe(upgraded);
  expect(tokenOf(oldName)).not.toBe(oldToken);

  expect(api.pods.get(oldName)?.spec["initContainers"]).toMatchObject([
    { image: "pipoca:test" },
  ]);

  expect((await poll(oldToken)).status).toBe(401);
  expect([...api.claims.keys()].sort()).toEqual([oldName, currentName].sort());
  expect(api.pods.get(currentName)).toBe(currentPod);
  expect(tokenOf(currentName)).toBe(currentToken);

  expect(
    t.log.filter(({ message }) => message === "runner pod replaced"),
  ).toHaveLength(1);
});

test("replaces a runner pod whose node ran another digest of the same moving tag, keeping its claim", async () => {
  const ran = (pod: FakePod | undefined, imageId: string): void => {
    if (pod) {
      pod.status = {
        phase: "Running",
        initContainerStatuses: [
          { name: "pipoca", image: "pipoca:test", imageID: imageId },
        ],
      };
    }
  };

  api.pods.set("pipoca-server", {
    metadata: { name: "pipoca-server", labels: {} },
    spec: { containers: [{ image: "pipoca:test", command: [] }] },
    status: {
      phase: "Running",
      containerStatuses: [
        {
          name: "server",
          image: "pipoca:test",
          imageID: "registry/pipoca@sha256:new",
        },
      ],
    },
  });

  const environment = await kubernetesEnvironment({ workspace: "claim" });
  const old = await startSession(environment);
  const current = await startSession(environment);
  const oldName = `pi-session-${old.id}`;
  const currentName = `pi-session-${current.id}`;
  await pass();

  const oldPod = api.pods.get(oldName);
  const currentPod = api.pods.get(currentName);
  const oldToken = tokenOf(oldName);
  const currentToken = tokenOf(currentName);
  ran(currentPod, "registry/pipoca@sha256:new");
  ran(oldPod, "registry/pipoca@sha256:old");
  await pass(3);

  expect(api.pods.get(oldName)).not.toBe(oldPod);
  expect(tokenOf(oldName)).not.toBe(oldToken);

  expect(oldPod?.spec["initContainers"]).toMatchObject([
    { image: "pipoca:test" },
  ]);

  expect([...api.claims.keys()].sort()).toEqual([oldName, currentName].sort());
  expect(api.pods.get(currentName)).toBe(currentPod);
  expect(tokenOf(currentName)).toBe(currentToken);
  expect(api.pods.get(oldName)?.spec["terminationGracePeriodSeconds"]).toBe(30);

  expect(
    t.log.filter(({ message }) => message === "runner pod replaced"),
  ).toHaveLength(1);
});
