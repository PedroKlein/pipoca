import { expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Environment, Session, SessionEvent } from "@pipoca/protocol";
import { readSse } from "@pipoca/protocol";
import { testServer } from "./testdata/harness";
import { until } from "@pipoca/plugins/testing";

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

test("prints the sign-in link for the desktop app without opening a browser", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pipoca-print-")));
  const bin = join(root, "bin");
  const opened = join(root, "opened");
  await mkdir(bin);

  for (const opener of ["open", "xdg-open"]) {
    await writeFile(join(bin, opener), `#!/bin/sh\necho "$1" >> ${opened}\n`);
    await chmod(join(bin, opener), 0o755);
  }

  const env = { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` };

  const run = (...args: string[]): ChildProcess =>
    spawn(
      process.execPath,
      [
        main,
        "up",
        "--port",
        "0",
        "--database",
        join(root, "server.db"),
        ...args,
      ],
      { env, stdio: ["ignore", "ignore", "pipe"] },
    );

  const printed = async (child: ChildProcess): Promise<string> =>
    new Promise((resolve) => {
      if (child.stderr === null) {
        return;
      }

      createInterface({ input: child.stderr }).on("line", (line) => {
        const found = /sign in at (\S+)/.exec(line);
        if (found?.[1] !== undefined) {
          resolve(found[1]);
        }
      });
    });

  const server = run("--folder", root, "--print-link");

  try {
    const link = await printed(server);
    const signedIn = await fetch(link, { redirect: "manual" });

    // A second up without the flag opens its link, so the opener works.
    const again = run();
    const reopened = await printed(again);
    await once(again, "exit");

    // The opener runs on its own and can finish after up exits.
    const openedLinks = async (): Promise<string> =>
      readFile(opened, "utf8").catch(() => "");

    await until(async () => (await openedLinks()).includes(reopened));

    expect({
      signedIn: signedIn.status,
      opened: (await openedLinks()).trim(),
    }).toEqual({ signedIn: 303, opened: reopened });
  } finally {
    server.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

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
      link: lines.some((line) => line.includes("/api/auth/links/")),
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
  const team = testServer({ database: join(root, "team.db") });

  const solo = testServer({
    database: join(root, "solo.db"),
    solo: { name: "pedro", socket },
  });

  try {
    const cookie = await soloCookie(socket);

    const [environment] = (await (
      await solo.as(cookie)("/api/environments")
    ).json()) as Environment[];

    expect({
      team: await pluginState(team.url, await team.signedIn(), "local"),
      solo: await pluginState(solo.url, cookie, "local"),
      soloSignIn: await pluginState(solo.url, cookie, "oidc"),
      runnersFrom: environment?.runnersFrom,
    }).toEqual({
      team: "off",
      solo: "on",
      soloSignIn: "off",
      runnersFrom: { plugin: "local", label: "This machine", icon: "monitor" },
    });
  } finally {
    await team.close();
    await solo.close();
    await rm(root, { recursive: true, force: true });
  }
});
