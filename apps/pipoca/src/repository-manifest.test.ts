import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test";
import { execFile, spawn } from "node:child_process";
import * as dns from "node:dns/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  EnvironmentTemplate,
  ManifestEntry,
  Profile,
  RepositoryManifest,
} from "@pipoca/protocol";
import { definePlugin, defineServer } from "@pipoca/plugins";
import { json, testServer, type TestServer } from "./testdata/harness";

const run = promisify(execFile);

// What the server's own lookups of a name answer, where a test says, or
// null for a lookup that fails.
const answers = new Map<string, string | null>();
const { lookup } = dns;

await mock.module("node:dns/promises", () => ({
  ...dns,
  lookup: async (host: string, options: unknown) => {
    const answer = answers.get(host);

    if (answer === null) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
        code: "ENOTFOUND",
      });
    }

    return answer === undefined
      ? lookup(host, options as never)
      : [{ address: answer, family: 4 }];
  },
}));

let certs: string;
let git: Bun.Server<undefined>;
let root: string;
let server: TestServer;

// Clones go over https only, so a git server with a throwaway certificate
// stands in for a git host.
beforeAll(async () => {
  certs = await mkdtemp(join(tmpdir(), "manifest-certs-"));

  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    "/CN=localhost",
    "-days",
    "1",
    "-keyout",
    join(certs, "key.pem"),
    "-out",
    join(certs, "cert.pem"),
  ]);

  process.env["GIT_SSL_NO_VERIFY"] = "true";

  git = Bun.serve({
    port: 0,
    tls: {
      key: Bun.file(join(certs, "key.pem")),
      cert: Bun.file(join(certs, "cert.pem")),
    },
    fetch: async (request) => httpBackend(request, join(root, "served")),
  });
});

afterAll(async () => {
  await git.stop(true);
  await rm(certs, { recursive: true, force: true });
});

// The git host on this machine is one everyone has a login for, so the
// server fetches from it although it is on a loopback address.
const hostLogins = defineServer(
  definePlugin({ id: "host-logins", title: "Host logins", description: "" }),
  ({ provide }) => {
    provide.gitCredentials(() => [
      { host: `localhost:${String(git.port)}`, token: "t" },
    ]);
  },
);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "manifest-"));

  server = testServer({
    database: join(root, "server.db"),
    configDir: join(root, "config"),
    servers: [hostLogins],
  });
});

// A person can't make the server fetch from the cluster's own network and
// read what git said about it.
test("fetches from a private address only from a host the person has a git login for, and keeps git's words to itself", async () => {
  const url = await repository({ "pipoca.json": "{}" });

  const loginless = testServer({ configDir: join(root, "loginless") });

  const refused = await loginless.api(
    `/api/repositories/manifest?url=${encodeURIComponent(url)}`,
  );

  const imported = await loginless.api("/api/profiles", {
    body: { source: { url } },
  });

  await loginless.close();

  expect(refused.status).toBe(400);
  expect(imported.status).toBe(400);

  const missing = await server.api(
    `/api/repositories/manifest?url=${encodeURIComponent(url.replace("team", "missing"))}`,
  );

  expect(missing.status).toBe(400);
  expect(JSON.stringify(await missing.json())).not.toMatch(/fatal|not found/i);
});

// A name can answer one address when the server checks it and another when
// git connects, so git connects only to the one it checked.
test("clones only from the address it checked", async () => {
  const url = await repository({ "pipoca.json": "{}" });
  const loginless = testServer({ configDir: join(root, "loginless") });

  // An address on no private range that refuses at once, where git's own
  // lookup of localhost would reach this machine.
  answers.set("localhost", "224.0.0.1");

  try {
    const listed = await loginless.api(
      `/api/repositories/manifest?url=${encodeURIComponent(url)}`,
    );

    expect(listed.status).toBe(400);
  } finally {
    answers.clear();
    await loginless.close();
  }
});

// Git looks the name up again itself, and can reach what the server's lookup
// couldn't.
test("refuses a host the server can't look up", async () => {
  const url = await repository({ "pipoca.json": "{}" });
  const loginless = testServer({ configDir: join(root, "loginless") });

  answers.set("localhost", null);

  try {
    const listed = await loginless.api(
      `/api/repositories/manifest?url=${encodeURIComponent(url)}`,
    );

    expect(listed.status).toBe(400);
  } finally {
    answers.clear();
    await loginless.close();
  }
});

// The server's own keys and agent may reach repositories the person can't.
test("clones over ssh for a person with none of the server's ssh setup", async () => {
  const bin = join(root, "bin");
  const said = join(root, "ssh-said");
  await mkdir(bin);

  await writeFile(
    join(bin, "ssh"),
    `#!/bin/sh\nprintf '%s\\n' "HOME=$HOME" "SSH_AUTH_SOCK=\${SSH_AUTH_SOCK-}" "$@" > '${said}'\nexit 255\n`,
    { mode: 0o755 },
  );

  const { PATH: path, SSH_AUTH_SOCK: agent } = process.env;
  process.env["PATH"] = `${bin}:${path ?? ""}`;
  process.env["SSH_AUTH_SOCK"] = join(root, "agent.sock");
  answers.set("git.example.com", "192.0.2.1");
  const loginless = testServer({ configDir: join(root, "loginless") });

  try {
    const imported = await loginless.api("/api/profiles", {
      body: { source: { url: "ssh://git@git.example.com/team.git" } },
    });

    expect(imported.status).toBe(400);
  } finally {
    process.env["PATH"] = path;

    if (agent === undefined) {
      delete process.env["SSH_AUTH_SOCK"];
    } else {
      process.env["SSH_AUTH_SOCK"] = agent;
    }

    answers.clear();
    await loginless.close();
  }

  const lines = (await Bun.file(said).text()).split("\n");

  expect(lines).not.toContain(`HOME=${process.env["HOME"] ?? ""}`);
  expect(lines).toContain("SSH_AUTH_SOCK=");

  for (const option of [
    "/dev/null",
    "IdentitiesOnly=yes",
    "IdentityFile=none",
    "IdentityAgent=none",
  ]) {
    expect(lines).toContain(option);
  }
});

// ::ffff:127.0.0.1 is the IPv6 spelling of a loopback address.
test("refuses an IPv4-mapped IPv6 address as its IPv4 address", async () => {
  const url = (await repository({ "pipoca.json": "{}" })).replace(
    "localhost",
    "[::ffff:127.0.0.1]",
  );

  const loginless = testServer({ configDir: join(root, "loginless") });

  try {
    const listed = await loginless.api(
      `/api/repositories/manifest?url=${encodeURIComponent(url)}`,
    );

    expect(listed.status).toBe(400);
  } finally {
    await loginless.close();
  }
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

test("imports the Profiles a repository's pipoca.json lists and follows the repository", async () => {
  const url = await repository({
    "pipoca.json": JSON.stringify({
      profiles: [
        { name: "Team review", path: "profiles/review" },
        { name: "Team docs", path: "profiles/docs/" },
      ],
    }),
    "profiles/review/AGENTS.md": "Review carefully.",
    "profiles/review/skills/lint/SKILL.md": "Run the linter.",
    "profiles/docs/AGENTS.md": "Write docs.",
  });

  const listed = await json<RepositoryManifest>(
    server.api(`/api/repositories/manifest?url=${encodeURIComponent(url)}`),
  );

  expect(listed.found).toBe(true);
  expect(listed.commit).toMatch(/^[0-9a-f]{40}$/);

  expect(listed.profiles).toEqual([
    {
      name: "Team review",
      path: "profiles/review",
      holds: { skills: 1, packages: 0, agentsMd: true },
    },
    {
      name: "Team docs",
      path: "profiles/docs",
      holds: { skills: 0, packages: 0, agentsMd: true },
    },
  ]);

  const review = await json<Profile>(
    server.api("/api/profiles", {
      body: { source: { url, path: "profiles/review" } },
    }),
  );

  expect([review.name, review.agentsMd]).toEqual([
    "Team review",
    "Review carefully.",
  ]);

  expect(review.source).toMatchObject({ url, path: "profiles/review" });

  const id = review.id;

  const edited = await server.api(`/api/profiles/${id}`, {
    method: "PATCH",
    body: { agentsMd: "Mine now." },
  });

  expect(edited.status).toBe(409);

  await change(url, {
    "profiles/review/AGENTS.md": "Review twice.",
    "profiles/review/skills/lint/SKILL.md": null,
  });

  const synced = await json<Profile>(
    server.api(`/api/profiles/${id}/syncs`, { body: {} }),
  );

  expect(synced.agentsMd).toBe("Review twice.");
  expect(synced.source?.commit).not.toBe(review.source?.commit);

  expect(
    (
      await json<{ path: string }[]>(server.api(`/api/profiles/${id}/files`))
    ).map(({ path }) => path),
  ).not.toContain("skills/lint/SKILL.md");

  const copy = await json<Profile>(
    server.api("/api/profiles", { body: { from: id } }),
  );

  expect([copy.name, copy.agentsMd, copy.source]).toEqual([
    "Team review copy",
    "Review twice.",
    null,
  ]);

  expect(
    (
      await server.api(`/api/profiles/${copy.id}`, {
        method: "PATCH",
        body: { agentsMd: "Mine now." },
      })
    ).status,
  ).toBe(200);
});

test("refuses a folder the manifest doesn't list or that leaves the repository", async () => {
  const url = await repository({
    "pipoca.json": JSON.stringify({
      profiles: [{ name: "Outside", path: "../elsewhere" }],
    }),
  });

  const listed = await server.api(
    `/api/repositories/manifest?url=${encodeURIComponent(url)}`,
  );

  expect(listed.status).toBe(400);

  const other = await repository(
    {
      "pipoca.json": JSON.stringify({
        profiles: [{ name: "Team", path: "team" }],
      }),
      "team/AGENTS.md": "Hi.",
      "secret/AGENTS.md": "No.",
    },
    "other",
  );

  const unlisted = await server.api("/api/profiles", {
    body: { source: { url: other, path: "secret" } },
  });

  expect(unlisted.status).toBe(400);
});

test("imports the templates a repository's pipoca.json lists and follows the repository", async () => {
  const url = await repository(
    {
      "pipoca.json": JSON.stringify({
        templates: [{ name: "Go services", path: "environments/go.json" }],
      }),
      "environments/go.json": JSON.stringify({
        isolation: "container",
        image: "golang:1.25",
        setupScript: "go install golang.org/x/tools/gopls@latest",
        variables: { CGO_ENABLED: "0" },
        models: { aliases: { models: { fast: ["openai/gpt-5-mini"] } } },
      }),
    },
    "platform",
  );

  const listed = await json<{ readonly templates: ManifestEntry[] }>(
    server.api(`/api/repositories/manifest?url=${encodeURIComponent(url)}`),
  );

  expect(listed.templates).toEqual([
    { name: "Go services", path: "environments/go.json" },
  ]);

  const go = await json<EnvironmentTemplate>(
    server.api("/api/environment-templates", {
      body: { source: { url, path: "environments/go.json" } },
    }),
  );

  expect(go).toMatchObject({
    id: "go-services",
    name: "Go services",
    isolation: "container",
    image: "golang:1.25",
    variables: { CGO_ENABLED: "0" },
    source: { url, path: "environments/go.json" },
  });

  const edited = await server.api("/api/environment-templates/go-services", {
    method: "PATCH",
    body: { image: "golang:1.26" },
  });

  expect(edited.status).toBe(409);

  await change(url, {
    "environments/go.json": JSON.stringify({
      isolation: "container",
      image: "golang:1.26",
    }),
  });

  const synced = await json<EnvironmentTemplate>(
    server.api("/api/environment-templates/go-services/syncs", { body: {} }),
  );

  expect([synced.image, synced.variables, synced.setupScript]).toEqual([
    "golang:1.26",
    {},
    "",
  ]);

  expect(synced.source?.commit).not.toBe(go.source?.commit);
});

test("refuses a template file that holds secrets", async () => {
  const url = await repository(
    {
      "pipoca.json": JSON.stringify({
        templates: [{ name: "Leaky", path: "leaky.json" }],
      }),
      "leaky.json": JSON.stringify({ secrets: { TOKEN: "s3cret" } }),
    },
    "leaky",
  );

  const imported = await server.api("/api/environment-templates", {
    body: { source: { url, path: "leaky.json" } },
  });

  expect(imported.status).toBe(400);

  expect(
    await json<EnvironmentTemplate[]>(server.api("/api/environment-templates")),
  ).toEqual([]);
});

// Whoever can push to the repository is not an admin, and a pod patch can
// mount the namespace's Secrets.
test("keeps a template's pod settings out of its repository's hands", async () => {
  const keyVolume = { name: "key", secret: { secretName: "pipoca" } };

  const url = await repository(
    {
      "pipoca.json": JSON.stringify({
        templates: [{ name: "Pods", path: "pods.json" }],
      }),
      "pods.json": JSON.stringify({
        kubernetes: { podPatch: { spec: { volumes: [keyVolume] } } },
      }),
    },
    "pods",
  );

  const pods = await json<EnvironmentTemplate>(
    server.api("/api/environment-templates", {
      body: { source: { url, path: "pods.json" } },
    }),
  );

  const path = `/api/ext/kubernetes/templates/${pods.id}`;

  const imported = await json<{ settings: unknown }>(server.api(path));

  const saved = await json<{ settings: unknown }>(
    server.api(path, { body: { settings: { maxPods: 2 } } }),
  );

  await change(url, {
    "pods.json": JSON.stringify({
      kubernetes: {
        maxPods: 50,
        podPatch: { spec: { volumes: [keyVolume] } },
      },
    }),
  });

  await json(
    server.api(`/api/environment-templates/${pods.id}/syncs`, {
      body: {},
    }),
  );

  const synced = await json<{ settings: unknown }>(server.api(path));

  expect([imported.settings, synced.settings]).toEqual([null, saved.settings]);
  expect(saved.settings).toMatchObject({ maxPods: 2, podPatch: {} });
});

async function repository(
  files: Readonly<Record<string, string>>,
  name = "team",
): Promise<string> {
  const work = join(root, "work", name);
  await run("git", ["init", "--quiet", "--initial-branch", "main", work]);
  await commit(work, files);

  const bare = join(root, "served", `${name}.git`);
  await run("git", ["clone", "--quiet", "--bare", work, bare]);

  return `https://localhost:${String(git.port)}/${name}.git`;
}

async function change(
  url: string,
  files: Readonly<Record<string, string | null>>,
): Promise<void> {
  const name =
    url
      .split("/")
      .pop()
      ?.replace(/\.git$/, "") ?? "";

  const work = join(root, "work", name);

  await commit(work, files);

  await run("git", [
    "-C",
    work,
    "push",
    "--quiet",
    join(root, "served", `${name}.git`),
    "main",
  ]);
}

async function commit(
  work: string,
  files: Readonly<Record<string, string | null>>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      await rm(join(work, path));
    } else {
      await mkdir(join(work, path, ".."), { recursive: true });
      await writeFile(join(work, path), content);
    }
  }

  await run("git", ["-C", work, "add", "--all"]);

  await run("git", [
    "-C",
    work,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "change",
  ]);
}

// Git's own smart HTTP server, run as a CGI program for each request.
async function httpBackend(
  request: Request,
  projects: string,
): Promise<Response> {
  const url = new URL(request.url);

  const backend = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: projects,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers.get("content-type") ?? "",
    },
  });

  backend.stdin.end(Buffer.from(await request.arrayBuffer()));

  const chunks: Buffer[] = [];
  for await (const chunk of backend.stdout) {
    chunks.push(chunk as Buffer);
  }

  const output = Buffer.concat(chunks);
  const end = output.indexOf("\r\n\r\n");
  const headers = new Headers();
  let status = 200;

  for (const line of output.subarray(0, end).toString().split("\r\n")) {
    const [key = "", ...rest] = line.split(":");
    const value = rest.join(":").trim();

    if (key.toLowerCase() === "status") {
      status = Number(value.split(" ")[0]);
    } else {
      headers.set(key, value);
    }
  }

  return new Response(output.subarray(end + 4), { status, headers });
}

test("says whether a repository has a pipoca.json at all, apart from one that lists no Profiles", async () => {
  const bare = await repository({ "README.md": "dotfiles" }, "bare");

  const empty = await repository(
    { "pipoca.json": JSON.stringify({ templates: [] }) },
    "empty",
  );

  const read = async (url: string) =>
    json<RepositoryManifest>(
      server.api(`/api/repositories/manifest?url=${encodeURIComponent(url)}`),
    );

  expect(await read(bare)).toMatchObject({ found: false, profiles: [] });
  expect(await read(empty)).toMatchObject({ found: true, profiles: [] });
});
