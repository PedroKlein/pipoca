import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  EnvironmentTemplate,
  ManifestEntry,
  Profile,
} from "@pipoca/protocol";
import { serve } from "./serve";
import { firstUser } from "./testdata/sign-in";

const run = promisify(execFile);

let certs: string;
let git: Bun.Server<undefined>;
let root: string;
let server: ReturnType<typeof serve>;
let signedIn: () => Promise<string>;

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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "manifest-"));

  const logs: string[] = [];

  server = serve({
    port: 0,
    database: join(root, "server.db"),
    configDir: join(root, "config"),
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  signedIn = firstUser(server, logs);
});

afterEach(async () => {
  await server.stop();
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

  const listed = await json<{ readonly profiles: ManifestEntry[] }>(
    api("/api/profiles/listed", { body: { url } }),
  );

  expect(listed.profiles).toEqual([
    { name: "Team review", path: "profiles/review" },
    { name: "Team docs", path: "profiles/docs" },
  ]);

  const imported = await json<{ readonly profiles: Profile[] }>(
    api("/api/profiles/import", {
      body: { url, paths: ["profiles/review"] },
    }),
  );

  const [review] = imported.profiles;

  expect(
    imported.profiles.map(({ name, agentsMd }) => [name, agentsMd]),
  ).toEqual([["Team review", "Review carefully."]]);

  expect(review?.source).toMatchObject({ url, path: "profiles/review" });

  const id = review?.id ?? "";

  const edited = await api(`/api/profiles/${id}`, {
    method: "PUT",
    body: { agentsMd: "Mine now." },
  });

  expect(edited.status).toBe(409);

  await change(url, {
    "profiles/review/AGENTS.md": "Review twice.",
    "profiles/review/skills/lint/SKILL.md": null,
  });

  const synced = await json<Profile>(
    api(`/api/profiles/${id}/sync`, { body: {} }),
  );

  expect(synced.agentsMd).toBe("Review twice.");
  expect(synced.source?.commit).not.toBe(review?.source?.commit);

  expect(
    (await json<{ path: string }[]>(api(`/api/profiles/${id}/files`))).map(
      ({ path }) => path,
    ),
  ).not.toContain("skills/lint/SKILL.md");

  const copy = await json<Profile>(
    api(`/api/profiles/${id}/copy`, { body: {} }),
  );

  expect([copy.name, copy.agentsMd, copy.source]).toEqual([
    "Team review copy",
    "Review twice.",
    null,
  ]);

  expect(
    (
      await api(`/api/profiles/${copy.id}`, {
        method: "PUT",
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

  const listed = await api("/api/profiles/listed", { body: { url } });

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

  const unlisted = await api("/api/profiles/import", {
    body: { url: other, paths: ["secret"] },
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
        aliases: { models: { fast: ["openai/gpt-5-mini"] } },
      }),
    },
    "platform",
  );

  const listed = await json<{ readonly templates: ManifestEntry[] }>(
    api("/api/templates/listed", { body: { url } }),
  );

  expect(listed.templates).toEqual([
    { name: "Go services", path: "environments/go.json" },
  ]);

  const imported = await json<{ readonly templates: EnvironmentTemplate[] }>(
    api("/api/templates/import", {
      body: { url, paths: ["environments/go.json"] },
    }),
  );

  const [go] = imported.templates;

  expect(go).toMatchObject({
    id: "go-services",
    name: "Go services",
    isolation: "container",
    image: "golang:1.25",
    variables: { CGO_ENABLED: "0" },
    aliases: { models: { fast: ["openai/gpt-5-mini"] } },
    source: { url, path: "environments/go.json" },
  });

  const edited = await api("/api/templates/go-services", {
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
    api("/api/templates/go-services/sync", { body: {} }),
  );

  expect([synced.image, synced.variables, synced.setupScript]).toEqual([
    "golang:1.26",
    {},
    "",
  ]);

  expect(synced.source?.commit).not.toBe(go?.source?.commit);
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

  const imported = await api("/api/templates/import", {
    body: { url, paths: ["leaky.json"] },
  });

  expect(imported.status).toBe(400);
  expect(await json<EnvironmentTemplate[]>(api("/api/templates"))).toEqual([]);
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

async function api(
  path: string,
  init: { readonly method?: string; readonly body?: unknown } = {},
): Promise<Response> {
  return fetch(new URL(path, server.url), {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      cookie: await signedIn(),
      ...(init.body !== undefined && { "content-type": "application/json" }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
}

async function json<T>(response: Promise<Response>): Promise<T> {
  const answer = await response;
  if (!answer.ok) {
    throw new Error(`${String(answer.status)} ${await answer.text()}`);
  }

  return (await answer.json()) as T;
}
