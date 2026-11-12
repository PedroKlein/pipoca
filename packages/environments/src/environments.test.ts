import { expect, test } from "bun:test";
import type { Workspace } from "@pipoca/protocol";
import { Environments, RunnerCredentials } from "./index";
import { memoryCredentials, memoryEnvironments } from "./testdata/memory-store";

function clock() {
  let now = Date.parse("2026-11-05T12:00:00Z");

  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function pool(options: { inUse?: boolean } = {}) {
  const time = clock();

  const environments = new Environments(memoryEnvironments(), {
    clock: time,
    offlineAfterMs: 1_000,
    leaseMs: 5_000,
    templates: () => [
      {
        id: "small",
        name: "Small",
        isolation: "container",
        image: "node:22",
        setupScript: "",
        variables: { REGION: "eu" },
        source: null,
      },
    ],
    sessions: () => ({
      running: () => 0,
      inUse: () => options.inUse === true,
      removed: () => undefined,
    }),
  });

  environments.create("vm", "ana");

  return { environments, time };
}

const poll = (
  environments: Environments,
  runner: string,
  inventory: { folders?: readonly string[]; session?: string } = {},
) =>
  environments.beginPoll(
    { name: runner, environment: "vm" },
    {
      capacity: null,
      inventory: { folders: inventory.folders ?? [], models: [], ...inventory },
    },
  );

const clone: Workspace = {
  kind: "clone",
  repository: "https://example.com/app",
  branch: "pipoca/1",
};

const folder: Workspace = { kind: "folder", path: "/home/ana/app" };

test("a new Session in a folder goes to the runner that lists it, while one is online", () => {
  const { environments, time } = pool();
  const endA = poll(environments, "a", { folders: ["/home/ana"] });
  const endB = poll(environments, "b");
  const session = { id: "s1", runner: null, workspace: folder };

  expect(environments.mayTake("vm", session, "a")).toBe(true);
  expect(environments.mayTake("vm", session, "b")).toBe(false);
  expect(environments.placesOnNewRunner("vm", session)).toBe(false);

  endA();
  endB();
  time.advance(1_000);

  expect(environments.online("vm", "a")).toBe(false);
  expect(environments.placesOnNewRunner("vm", session)).toBe(true);
});

test("a Session goes back to its runner until the runner's lease lapses", () => {
  const { environments, time } = pool();
  const end = poll(environments, "a");
  poll(environments, "b");
  const ran = { id: "s1", runner: "a", workspace: clone };
  const pinned = { id: "s2", runner: "a", workspace: folder };

  end();
  time.advance(4_999);

  expect(environments.mayTake("vm", ran, "b")).toBe(false);

  time.advance(1);

  expect(environments.leaseLapsed("vm", "a")).toBe(true);
  expect(environments.mayTake("vm", ran, "b")).toBe(true);
  expect(environments.mayTake("vm", pinned, "b")).toBe(false);
});

test("a runner unseen since the server started keeps its lease for a full lease", () => {
  const { environments, time } = pool();

  expect(environments.leaseLapsed("vm", "gone")).toBe(false);

  time.advance(5_000);

  expect(environments.leaseLapsed("vm", "gone")).toBe(true);
});

test("a runner started for one Session takes only that Session, and it only that runner", () => {
  const { environments } = pool();
  poll(environments, "pod", { session: "s1" });
  poll(environments, "any");
  const own = { id: "s1", runner: null, workspace: clone };
  const other = { id: "s2", runner: null, workspace: clone };

  expect(environments.mayTake("vm", own, "pod")).toBe(true);
  expect(environments.mayTake("vm", own, "any")).toBe(false);
  expect(environments.mayTake("vm", other, "pod")).toBe(false);
  expect(environments.mayTake("vm", other, "any")).toBe(true);
});

test("names a joining runner's Environment after it, numbered when taken", () => {
  const { environments } = pool();

  expect(environments.createForRunner("vm", "ana").provider).toBe("vm-2");
  expect(environments.createForRunner("laptop", "ana").provider).toBe("laptop");
});

test("an Environment from a template runs as the template says", () => {
  const { environments } = pool();
  const made = environments.create("small-1", "team", "small");
  const id = made.ok ? made.value.id : "";

  expect(environments.create("vm", "ana")).toEqual({
    ok: false,
    reason: "environment_exists",
  });

  expect(environments.update(id, { image: "alpine" })).toEqual({
    ok: false,
    reason: "from_template",
  });

  environments.update(id, { variables: { DEBUG: "1" }, secrets: { T: "x" } });

  expect(environments.sessionEnvironment(id)).toEqual({
    isolation: "container",
    image: "node:22",
    setupScript: "",
    variables: { REGION: "eu", DEBUG: "1", T: "x" },
  });

  expect(environments.list().find((each) => each.id === id)?.secrets).toEqual([
    "T",
  ]);
});

test("people each get their own Environment of the same name from a template", () => {
  const { environments } = pool();
  const ana = environments.create("small", "ana", "small");
  const bob = environments.create("small", "bob", "small");

  expect(ana.ok && bob.ok).toBe(true);

  const owned = environments
    .list()
    .filter(({ templateId }) => templateId === "small")
    .map(({ name, ownerId }) => ({ name, ownerId }));

  expect(owned).toEqual([
    { name: "small", ownerId: "ana" },
    { name: "small", ownerId: "bob" },
  ]);

  expect(environments.create("small", "bob", "small")).toEqual({
    ok: false,
    reason: "environment_exists",
  });
});

test("an Environment whose Sessions still run can't be deleted", () => {
  const busy = pool({ inUse: true });
  const idle = pool();
  const id = (environments: Environments) => environments.all()[0]?.id ?? "";

  expect(busy.environments.remove(id(busy.environments))).toEqual({
    ok: false,
    reason: "environment_in_use",
  });

  expect(idle.environments.remove(id(idle.environments)).ok).toBe(true);
  expect(idle.environments.all()).toEqual([]);
});

const bearer = (token: string) =>
  new Request("http://localhost/agent/work", {
    headers: { authorization: `Bearer ${token}` },
  });

test("the first runner to join with a join key gets an Environment, and the key becomes its", () => {
  const credentials = new RunnerCredentials(memoryCredentials());
  const key = credentials.newJoinKey("ana");
  const online = new Set<string>();
  const made: string[] = [];

  const environments = {
    create: (runner: string, owner: string) => {
      made.push(`${runner} for ${owner}`);

      return runner;
    },
    online: (_environment: string, runner: string) => online.has(runner),
  };

  const first = credentials.join(key, "laptop", environments);
  online.add("laptop");

  expect(first).toMatchObject({ environment: "laptop" });
  expect(credentials.join(key, "laptop", environments)).toBe("online");

  expect(credentials.join(key, "desk", environments)).toMatchObject({
    environment: "laptop",
  });

  expect(credentials.join("pck_wrong", "desk", environments)).toBeUndefined();
  expect(made).toEqual(["laptop for ana"]);

  const token = first !== undefined && first !== "online" ? first.token : "";

  expect(credentials.callerOf(bearer(token))).toMatchObject({
    environment: "laptop",
    runner: "laptop",
    sessionId: null,
  });

  credentials.newKey("laptop");

  expect(credentials.callerOf(bearer(token))).toBeUndefined();
});

test("a runner token nobody used for its days stops working, with its Sessions' tokens", () => {
  const time = clock();

  const credentials = new RunnerCredentials(memoryCredentials(), {
    clock: time,
    runnerTokenDays: () => 2,
  });

  const runner = credentials.runnerToken("vm", "pod");
  const caller = credentials.callerOf(bearer(runner));
  const session = credentials.sessionToken(caller ?? never(), "s1");

  time.advance(24 * 60 * 60_000);

  expect(credentials.callerOf(bearer(runner))?.runner).toBe("pod");

  time.advance(2 * 24 * 60 * 60_000 + 1);

  expect(credentials.callerOf(bearer(runner))).toBeUndefined();

  const other = credentials.runnerToken("vm", "other");
  time.advance(2 * 24 * 60 * 60_000);
  credentials.callerOf(bearer(other));

  expect(credentials.callerOf(bearer(session))).toBeUndefined();
});

test("the server's own runner keeps its tokens in memory, where a new key leaves them be", () => {
  const credentials = new RunnerCredentials(memoryCredentials());
  const own = credentials.ownRunnerToken("vm", "vm");
  const caller = credentials.callerOf(bearer(own)) ?? never();
  const first = credentials.sessionToken(caller, "s1");
  const second = credentials.sessionToken(caller, "s1");

  credentials.newKey("vm");

  expect(credentials.callerOf(bearer(own))?.runner).toBe("vm");
  expect(credentials.callerOf(bearer(first))).toBeUndefined();
  expect(credentials.callerOf(bearer(second))?.sessionId).toBe("s1");
});

function never(): never {
  throw new Error("expected a caller");
}

test("a Session on a private host goes only to runners that reached it, and the Environment lists what its runners reach", () => {
  const environments = new Environments(memoryEnvironments(), {
    privateHost: (host) => host === "github.acme.internal",
  });

  environments.create("vm", "ana");

  const reaching = environments.beginPoll(
    { name: "a", environment: "vm" },
    {
      capacity: null,
      inventory: {
        folders: [],
        models: [],
        reach: [{ host: "github.acme.internal", port: 443, reached: true }],
      },
    },
  );

  const other = poll(environments, "b");

  const internal: Workspace = {
    kind: "clone",
    repository: "git@github.acme.internal:acme/payments.git",
    branch: "pipoca/1",
  };

  const session = { id: "s1", runner: null, workspace: internal };

  expect(environments.reaches("vm", internal)).toBe(true);
  expect(environments.mayTake("vm", session, "a")).toBe(true);
  expect(environments.mayTake("vm", session, "b")).toBe(false);

  expect(
    environments.mayTake("vm", { ...session, workspace: clone }, "b"),
  ).toBe(true);

  expect(environments.list()[0]?.reaches).toEqual([
    { host: "github.acme.internal", port: 443, reached: true },
  ]);

  reaching();
  other();
});

test("an Environment whose runners didn't reach a private host doesn't reach a repository there", () => {
  const environments = new Environments(memoryEnvironments(), {
    privateHost: (host) => host === "github.acme.internal",
  });

  environments.create("vm", "ana");

  const end = environments.beginPoll(
    { name: "a", environment: "vm" },
    {
      capacity: null,
      inventory: {
        folders: [],
        models: [],
        reach: [{ host: "github.acme.internal", port: 443, reached: false }],
      },
    },
  );

  expect(
    environments.reaches("vm", {
      kind: "clone",
      repository: "https://github.acme.internal/acme/payments",
    }),
  ).toBe(false);

  expect(environments.reaches("vm", folder)).toBe(true);

  end();
});
