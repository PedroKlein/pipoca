import { expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Environment, Session, SessionEvent } from "@pipoca/protocol";
import { serve } from "./serve";
import { readSse } from "./sse";
import { firstUser } from "./testdata/sign-in";

const main = join(import.meta.dirname, "main.ts");

// Starts `pipoca up` with no browser to open and signs in with the link it
// prints.
async function up(
  root: string,
  folder: string,
): Promise<{
  readonly server: ChildProcess;
  readonly url: URL;
  readonly cookie: string;
}> {
  const server = spawn(
    process.execPath,
    [
      main,
      "up",
      "--port",
      "0",
      "--database",
      join(root, "server.db"),
      "--folder",
      folder,
    ],
    {
      env: { ...process.env, PIPOCA_FAUX_REPLY: "hi from this machine" },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );

  const link = await new Promise<string>((resolve) => {
    createInterface({ input: server.stderr }).on("line", (line) => {
      const found = /sign in at (\S+)/.exec(line);
      if (found?.[1] !== undefined) {
        resolve(found[1]);
      }
    });
  });

  const signedIn = await fetch(link, { redirect: "manual" });
  const cookie = signedIn.headers.get("set-cookie")?.split(";")[0] ?? "";

  return { server, url: new URL("/", link), cookie };
}

test("pipoca up runs a Session on a runner it starts on this machine", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pipoca-up-")));
  const controller = new AbortController();
  const { server, url, cookie } = await up(root, root);

  try {
    const environments = (await (
      await fetch(new URL("/api/environments", url), { headers: { cookie } })
    ).json()) as Environment[];

    const environment = environments.find(
      ({ provider }) => provider === "this-machine",
    );

    expect({
      name: environment?.name,
      onDemand: environment?.onDemand,
      online: environment?.runners.some(({ online }) => online),
    }).toEqual({ name: "This machine", onDemand: true, online: false });

    const created = await fetch(new URL("/api/sessions", url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        environment: environment?.id,
        workspace: { kind: "folder", path: root },
      }),
    });

    const { id } = (await created.json()) as Session;

    const stream = await fetch(new URL(`/api/sessions/${id}/events`, url), {
      signal: controller.signal,
      headers: { cookie },
    });

    let settled: Session | undefined;
    for await (const event of readSse(stream) as AsyncGenerator<SessionEvent>) {
      if (
        event.type === "session" &&
        (event.session.status === "idle" || event.session.status === "failed")
      ) {
        settled = event.session;
        break;
      }
    }

    expect({
      status: settled?.status,
      error: settled?.error,
      runner: settled?.runner,
    }).toEqual({ status: "idle", error: null, runner: "this-machine" });

    server.kill("SIGTERM");
    await once(server, "exit");
  } finally {
    controller.abort();
    server.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("only opens a new link when a solo server already runs", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pipoca-up-")));
  const { server } = await up(root, root);

  try {
    const again = spawn(
      process.execPath,
      [main, "up", "--port", "0", "--database", join(root, "server.db")],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    const lines: string[] = [];

    createInterface({ input: again.stderr }).on("line", (line) => {
      lines.push(line);
    });

    const [code] = (await once(again, "exit")) as [number | null];

    expect({
      code,
      link: lines.some((line) => line.includes("/api/auth/link/")),
      listening: lines.some((line) => line.includes("server listening")),
    }).toEqual({ code: 0, link: true, listening: false });
  } finally {
    server.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

async function soloCookie(socket: string): Promise<string> {
  const response = await fetch("http://localhost/link", {
    method: "POST",
    unix: socket,
  });

  const { url } = (await response.json()) as { url: string };
  const signedIn = await fetch(url, { redirect: "manual" });

  return signedIn.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function pluginState(
  url: URL,
  cookie: string,
  plugin: string,
): Promise<string | undefined> {
  const response = await fetch(new URL("/api/plugins", url), {
    headers: { cookie },
  });

  const plugins = (await response.json()) as { id: string; state: string }[];

  return plugins.find(({ id }) => id === plugin)?.state;
}

test("runs runners on its own machine only in a solo install, which signs no one else in", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pipoca-up-")));
  const socket = join(root, "run", "pipoca.sock");
  const logs: string[] = [];

  const team = serve({
    port: 0,
    database: join(root, "team.db"),
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  const solo = serve({
    port: 0,
    database: join(root, "solo.db"),
    solo: { name: "pedro", socket },
    log: () => undefined,
  });

  try {
    const cookie = await soloCookie(socket);

    const [environment] = (await (
      await fetch(new URL("/api/environments", solo.url), {
        headers: { cookie },
      })
    ).json()) as Environment[];

    const refused = await fetch(
      new URL(
        `/api/plugins/local/environments/${environment?.id ?? ""}`,
        solo.url,
      ),
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          settings: { folders: [join(root, "missing")] },
        }),
      },
    );

    expect({
      team: await pluginState(team.url, await firstUser(team, logs)(), "local"),
      solo: await pluginState(solo.url, cookie, "local"),
      soloSignIn: await pluginState(solo.url, cookie, "oidc"),
      status: refused.status,
      message: ((await refused.json()) as { message: string }).message,
    }).toEqual({
      team: "off",
      solo: "on",
      soloSignIn: "off",
      status: 400,
      message: `${join(root, "missing")} isn't a folder on this machine`,
    });
  } finally {
    await team.stop();
    await solo.stop();
    await rm(root, { recursive: true, force: true });
  }
});
