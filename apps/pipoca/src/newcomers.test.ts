import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testServer, type TestServer } from "./testdata/harness";

let root: string;
let server: TestServer;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "newcomers-"));

  server = testServer({
    configDir: join(root, "config"),
    runners: { pollWaitMs: 0 },
  });
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

async function newcomers(body?: unknown): Promise<Response> {
  return server.api("/api/settings/newcomers", {
    method: body === undefined ? "GET" : "PUT",
    body,
  });
}

test("an admin keeps what new people get in pipoca.json", async () => {
  expect(await (await newcomers()).json()).toEqual({
    template: null,
    profiles: [],
    required: [],
  });

  const chosen = {
    template: "pods",
    profiles: ["backend", "backend"],
    required: ["git-hosts"],
  };

  expect((await newcomers(chosen)).status).toBe(200);

  const saved = { ...chosen, profiles: ["backend"] };

  expect(await (await newcomers()).json()).toEqual(saved);

  expect(
    JSON.parse(await readFile(join(root, "config", "pipoca.json"), "utf8")),
  ).toEqual({ newcomers: saved });
});

test("refuses what new people get when it doesn't fit", async () => {
  expect((await newcomers({ profiles: "backend" })).status).toBe(422);
  expect((await newcomers({ template: 3 })).status).toBe(422);
});

async function joinInfo(): Promise<unknown> {
  const [link] = (await (
    await server.api("/api/invites", { body: {} })
  ).json()) as { readonly token: string }[];

  return (
    await fetch(new URL(`/api/auth/invites/${link?.token ?? ""}`, server.url))
  ).json();
}

test("an invite shows what the team set up and what's left to the newcomer", async () => {
  expect(await joinInfo()).toMatchObject({
    team: null,
    setUp: [],
    yours: [
      { title: "Where Pi works", optional: false },
      { title: "Your Profile", optional: true },
    ],
  });

  const template = (await (
    await server.api("/api/environment-templates", {
      body: { name: "Cluster pods", setupScript: "" },
    })
  ).json()) as { readonly id: string };

  const backend = (await (
    await server.api("/api/profiles", {
      body: { name: "Backend", shared: true, agentsMd: "Go" },
    })
  ).json()) as { readonly id: string };

  await server.api("/api/settings/base-profile", {
    method: "PUT",
    body: {
      agentsMd: "House rules.",
      packages: ["npm:review-skills"],
      mcpServers: { linear: { url: "https://mcp.linear.app/sse" } },
    },
  });

  await server.api("/api/settings/team", {
    method: "PUT",
    body: { name: "Platform" },
  });

  await newcomers({
    template: template.id,
    profiles: [backend.id],
    required: ["git-hosts", "profile"],
  });

  expect(await joinInfo()).toMatchObject({
    team: "Platform",
    setUp: [
      {
        title: "Cluster pods",
        summary: "You get your own Environment from it",
      },
      {
        title: "Team base Profile",
        summary: "Instructions, 1 package, linear",
      },
      { title: "Profiles to pick from", summary: "Backend" },
    ],
    yours: [
      { title: "Git hosts", summary: "Your team asks for it", optional: false },
      {
        title: "Your Profile",
        summary: "One of the team's, or your own",
        optional: false,
      },
    ],
  });
});

test("keeps what new people get to signed-in people", async () => {
  expect(
    (await fetch(new URL("/api/settings/newcomers", server.url))).status,
  ).toBe(401);
});
