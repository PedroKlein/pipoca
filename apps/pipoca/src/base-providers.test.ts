import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GitLogin,
  type ProfileFiles,
  systemTimer,
} from "@pipoca/protocol";
import { until } from "@pipoca/testing/until";
import { definePlugin, defineServer } from "@pipoca/plugins";
import { pipoca } from "./binary";
import { testServer } from "./testdata/harness";
import {
  type BaseListing,
  type BaseListingStore,
  baseProviders,
} from "./base-providers";

let root: string;
let scratch: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "base-providers-"));
  scratch = join(root, "scratch");
  await mkdir(scratch);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// A Pi package whose extension registers a provider, or runs the code given.
async function providerPackage(
  name: string,
  code = `pi.registerProvider("${name}", {
    name: "${name} models",
    baseUrl: "http://127.0.0.1:9/v1",
    api: "openai-completions",
    models: [{ id: "${name}-1", name: "${name}-1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
  });`,
): Promise<string> {
  const dir = join(root, name);
  await mkdir(join(dir, "extensions"), { recursive: true });

  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name, pi: { extensions: ["./extensions"] } }),
  );

  await writeFile(
    join(dir, "extensions", "index.ts"),
    `export default async (pi) => { ${code} };`,
  );

  return dir;
}

function baseWith(packages: readonly string[], hash = "h1"): ProfileFiles {
  return {
    hash,
    files: {
      "settings.json": Buffer.from(JSON.stringify({ packages })).toString(
        "base64",
      ),
    },
  };
}

function memoryStore(): BaseListingStore & { saved: () => number } {
  let listing: BaseListing | undefined;
  let saved = 0;

  return {
    get: () => listing,
    set: (next) => {
      listing = next;
      saved += 1;
    },
    saved: () => saved,
  };
}

function lister(
  base: () => ProfileFiles | undefined,
  o: {
    readonly store?: BaseListingStore;
    readonly timeoutMs?: number;
    readonly gitLogins?: (repository: string) => readonly GitLogin[];
  } = {},
) {
  const logs: string[] = [];
  let changes = 0;

  const providers = baseProviders({
    base,
    store: o.store ?? memoryStore(),
    command: pipoca,
    dir: scratch,
    timer: systemTimer,
    gitLogins: o.gitLogins ?? (() => []),
    changed: () => {
      changes += 1;
    },
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
    settleMs: 0,
    ...(o.timeoutMs !== undefined && { timeoutMs: o.timeoutMs }),
  });

  return { providers, logs, changes: () => changes };
}

test("lists the providers the base's packages register, skipping one that doesn't install", async () => {
  const fake = await providerPackage("fake-ai");
  const missing = join(root, "missing-package");
  const { providers, logs, changes } = lister(() => baseWith([fake, missing]));

  providers.check();

  const listed = await until(
    () => providers.list(),
    (found) => found.length > 0,
    30_000,
  );

  expect(listed).toEqual([
    {
      id: "fake-ai",
      name: "fake-ai models",
      apiKey: true,
      oauth: false,
      models: ["fake-ai-1"],
    },
  ]);

  expect(changes()).toBe(1);

  expect(
    logs.find((line) => line.startsWith("profile package not installed")),
  ).toContain("missing-package");

  expect(
    logs.find((line) => line.startsWith("base providers listed")),
  ).toContain("missing-package");

  await providers.stop();
  expect(await readdir(scratch)).toEqual([]);
}, 60_000);

test("a package that fails to load is skipped, and the others still list", async () => {
  const fake = await providerPackage("fake-ai");
  const broken = await providerPackage("broken", `throw new Error("no luck");`);

  const { providers, logs } = lister(() => baseWith([broken, fake]));
  providers.check();

  await until(
    () => providers.list(),
    (found) => found.length > 0,
    30_000,
  );

  expect(providers.list().map(({ id }) => id)).toEqual(["fake-ai"]);

  expect(
    logs.find((line) => line.startsWith("profile package not loaded")),
  ).toContain("broken");

  await providers.stop();
}, 60_000);

test("a listing that hangs is stopped after its timeout and the server keeps going", async () => {
  const hanging = await providerPackage(
    "hanging",
    "await new Promise(() => undefined);",
  );

  const store = memoryStore();

  const { providers, logs } = lister(() => baseWith([hanging]), {
    store,
    timeoutMs: 3000,
  });

  providers.check();

  await until(
    () => logs,
    (lines) => lines.some((line) => line.startsWith("base providers not")),
    30_000,
  );

  expect(logs.find((line) => line.startsWith("base providers not"))).toBe(
    'base providers not listed {"reason":"timed out"}',
  );

  expect(providers.list()).toEqual([]);
  expect(store.saved()).toBe(0);

  await providers.stop();
}, 60_000);

test("lists again only when the base changes, and keeps the last listing", async () => {
  const fake = await providerPackage("fake-ai");
  const store = memoryStore();
  let base = baseWith([fake]);

  const first = lister(() => base, { store });
  first.providers.check();

  await until(
    () => first.providers.list(),
    (found) => found.length > 0,
    30_000,
  );

  await first.providers.stop();

  const again = lister(() => base, { store });
  expect(again.providers.list().map(({ id }) => id)).toEqual(["fake-ai"]);

  again.providers.check();
  await Bun.sleep(200);

  expect(again.logs.some((line) => line.startsWith("listing base"))).toBe(
    false,
  );

  base = baseWith([], "h2");
  again.providers.check();

  await until(
    () => again.providers.list(),
    (found) => found.length === 0,
    30_000,
  );

  expect(again.changes()).toBe(1);
  await again.providers.stop();
}, 60_000);

// A git on PATH that writes what each call got and fails, as a private host
// the test can't reach would.
async function recordingGit(seen: string): Promise<string> {
  const bin = join(root, "bin");
  await mkdir(bin);

  await writeFile(
    join(bin, "git"),
    `#!/bin/sh\necho "$* $(env | grep '^PIPOCA_GIT_TOKEN' | sort | tr '\\n' ' ') $(env | grep '^GIT_CONFIG_KEY' | sort | tr '\\n' ' ')" >> ${seen}\nexit 1\n`,
    { mode: 0o755 },
  );

  return bin;
}

async function listedWith(
  packages: readonly string[],
  gitLogins: (repository: string) => readonly GitLogin[],
): Promise<readonly string[]> {
  const { providers, logs } = lister(() => baseWith(packages), { gitLogins });
  providers.check();

  await until(
    () => logs,
    (lines) => lines.some((line) => line.startsWith("base providers listed")),
    30_000,
  );

  await providers.stop();

  return logs;
}

test("a git package installs with the logins for its host, which the packages' code never sees", async () => {
  const seen = join(root, "seen");
  const bin = await recordingGit(seen);
  const read = join(root, "read");

  const spy = await providerPackage(
    "spy",
    `await (await import("node:fs/promises")).writeFile(${JSON.stringify(read)}, String(process.env["PIPOCA_GIT_TOKEN_0"] ?? "none"));`,
  );

  const asked: string[] = [];

  const corp = (repository: string): readonly GitLogin[] => {
    asked.push(repository);

    return repository.startsWith("https://git.corp.example/")
      ? [{ host: "git.corp.example", token: "corp-secret" }]
      : [];
  };

  const path = process.env["PATH"];
  process.env["PATH"] = `${bin}:${path ?? ""}`;

  try {
    const logs = await listedWith(
      ["git:git.corp.example/team/vault@v1", spy],
      corp,
    );

    const [clone] = (await readFile(seen, "utf8")).split("\n");

    expect(asked).toEqual(["https://git.corp.example/team/vault"]);
    expect(clone).toContain("clone https://git.corp.example/team/vault");
    expect(clone).toContain("PIPOCA_GIT_TOKEN_0=corp-secret");
    expect(clone).toContain("credential.https://git.corp.example.helper");
    expect(await readFile(read, "utf8")).toBe("none");
    expect(logs.join("\n")).toContain("git.corp.example/team/vault");
    expect(logs.join("\n")).not.toContain("corp-secret");

    await rm(seen);
    await listedWith(["git:other.example/team/kit"], corp);
    const [other] = (await readFile(seen, "utf8")).split("\n");

    expect(other).toContain("clone https://other.example/team/kit");
    expect(other).not.toContain("corp-secret");
    expect(other).not.toContain("credential.");
  } finally {
    process.env["PATH"] = path;
  }
}, 60_000);

// The admin has a login on the corporate host, and the team's bots one on
// each host.
const hostLogins = defineServer(
  definePlugin({ id: "host-logins", title: "Host logins", description: "" }),
  ({ provide }) => {
    provide.gitCredentials((owner) =>
      owner === "team"
        ? [
            { host: "git.corp.example", token: "team-corp" },
            { host: "other.example", token: "team-other" },
          ]
        : [{ host: "git.corp.example", token: "admin-corp" }],
    );
  },
);

test("the server installs the base's git packages with the logins of the admin who changed it, else the team's", async () => {
  const seen = join(root, "seen");
  const bin = await recordingGit(seen);
  const path = process.env["PATH"];
  process.env["PATH"] = `${bin}:${path ?? ""}`;

  const server = testServer({
    database: join(root, "server.db"),
    configDir: join(root, "config"),
    servers: [hostLogins],
  });

  try {
    const updated = await server.api("/api/settings/base-profile", {
      method: "PUT",
      body: {
        packages: ["git:git.corp.example/team/vault", "git:other.example/kit"],
      },
    });

    expect(updated.status).toBe(200);

    await until(
      () => server.logs,
      (lines) => lines.some((line) => line.startsWith("base providers listed")),
      30_000,
    );

    const clones = (await readFile(seen, "utf8")).split("\n");
    const corp = clones.find((line) => line.includes("git.corp.example/"));
    const other = clones.find((line) => line.includes("other.example/kit"));

    expect(corp).toContain("=admin-corp");
    expect(corp).not.toContain("team-corp");
    expect(other).toContain("=team-other");
    expect(server.logs.join("\n")).not.toMatch(/admin-corp|team-/);
  } finally {
    process.env["PATH"] = path;
    await server.close();
  }
}, 60_000);
