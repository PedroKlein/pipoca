import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProfileFiles, systemTimer } from "@pipoca/protocol";
import { until } from "@pipoca/testing/until";
import { pipoca } from "./binary";
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
  o: { readonly store?: BaseListingStore; readonly timeoutMs?: number } = {},
) {
  const logs: string[] = [];
  let changes = 0;

  const providers = baseProviders({
    base,
    store: o.store ?? memoryStore(),
    command: pipoca,
    dir: scratch,
    timer: systemTimer,
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
