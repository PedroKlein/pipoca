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
  stat,
  writeFile,
} from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import type { Environment } from "@pipoca/protocol";

const main = join(import.meta.dirname, "main.ts");

// Stands in for ssh on one machine: -N -L forwards the port, anything else
// runs the remote command here.
const fakeSsh = `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("-N")) {
  const forward = args[args.indexOf("-L") + 1];
  const [, local, , remote] = forward.split(":");
  Bun.listen({
    hostname: "127.0.0.1",
    port: Number(local),
    socket: {
      open: (client) => {
        const waiting = [];
        client.data = { waiting };
        void Bun.connect({
          hostname: "127.0.0.1",
          port: Number(remote),
          socket: {
            data: (_, chunk) => client.write(chunk),
            close: () => client.end(),
          },
        }).then((server) => {
          client.data.server = server;
          for (const chunk of waiting) server.write(chunk);
        });
      },
      data: (client, chunk) =>
        client.data.server
          ? client.data.server.write(chunk)
          : client.data.waiting.push(chunk),
      close: (client) => client.data.server?.end(),
    },
  });
} else {
  const [, ...command] = args;
  const run = Bun.spawn(command, { stdio: ["ignore", "inherit", "inherit"] });
  process.exit(await run.exited);
}
`;

async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");

  return port;
}

async function listening(server: {
  readonly stderr: Readable;
}): Promise<URL> {
  return new Promise((resolve) => {
    createInterface({ input: server.stderr }).on("line", (line) => {
      if (line.includes("server listening")) {
        resolve(new URL((JSON.parse(line) as { url: string }).url));
      }
    });
  });
}

async function executable(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

test("connect joins this machine as a runner of a solo server through an SSH tunnel", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pipoca-connect-")));
  const bin = join(root, "bin");
  const database = join(root, "remote", "server.db");
  await mkdir(bin);
  await executable(join(bin, "ssh"), fakeSsh);

  await executable(
    join(root, "remote-pipoca"),
    `#!/bin/sh\nexec ${process.execPath} ${main} "$@" --database ${database}\n`,
  );

  const server = spawn(
    process.execPath,
    [main, "server", "--solo", "--port", "0", "--database", database],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const running: ChildProcess[] = [server];

  try {
    const remote = await listening(server);
    const localPort = await freePort();

    const connecting = spawn(
      process.execPath,
      [
        main,
        "connect",
        "me@vm",
        "--port",
        remote.port,
        "--local-port",
        String(localPort),
        "--remote-pipoca",
        join(root, "remote-pipoca"),
        "--name",
        "laptop",
        "--data-dir",
        join(root, "connect"),
        "--folder",
        root,
        "--no-open",
      ],
      {
        env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
        stdio: "ignore",
      },
    );

    running.push(connecting);

    const link = spawn(
      process.execPath,
      [main, "link", "--database", database],
      { stdio: ["ignore", "pipe", "ignore"] },
    );

    const [url] = (await once(
      createInterface({ input: link.stdout }),
      "line",
    )) as [string];

    const signedIn = await fetch(url, { redirect: "manual" });
    const cookie = signedIn.headers.get("set-cookie")?.split(";")[0] ?? "";

    let laptop: Environment | undefined;
    for (let i = 0; i < 200 && laptop === undefined; i++) {
      const response = await fetch(new URL("/api/environments", remote), {
        headers: { cookie },
      });

      laptop = ((await response.json()) as Environment[]).find(
        ({ provider, online }) => provider === "laptop" && online,
      );

      await sleep(50);
    }

    const tunnelled = await fetch(
      `http://127.0.0.1:${String(localPort)}/api/auth`,
    );

    expect({
      online: laptop?.online,
      folders: laptop?.folders,
      tunnel: tunnelled.ok,
    }).toEqual({ online: true, folders: [root], tunnel: true });

    connecting.kill("SIGTERM");
    const [code] = (await once(connecting, "exit")) as [number | null];

    expect(code).toBe(0);
  } finally {
    for (const each of running) {
      each.kill("SIGKILL");
    }

    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("service install runs up at login as a solo server with systemd, and uninstall removes it", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pipoca-service-")));
  const bin = join(root, "bin");
  const calls = join(root, "calls");
  await mkdir(bin);

  await executable(
    join(bin, "systemctl"),
    `#!/bin/sh\necho "$@" >> ${calls}\n`,
  );

  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:${process.env["PATH"] ?? ""}`,
  };

  const run = async (...args: string[]): Promise<number | null> => {
    const child = spawn(process.execPath, [main, "service", ...args], {
      cwd: root,
      env,
      stdio: "ignore",
    });

    const [code] = (await once(child, "exit")) as [number | null];

    return code;
  };

  try {
    const unitPath = join(root, ".config", "systemd", "user", "pipoca.service");

    expect(await run("install", "up", "--port", "7421")).toBe(0);

    const unit = await readFile(unitPath, "utf8");
    const installed = (await readFile(calls, "utf8")).trim().split("\n");

    expect(await run("uninstall")).toBe(0);

    expect({
      execStart: unit.split("\n").find((line) => line.startsWith("ExecStart=")),
      calls: installed,
      removed: await stat(unitPath).then(
        () => false,
        () => true,
      ),
    }).toEqual({
      execStart: `ExecStart=${process.execPath} ${main} server --solo --folder ${root} --port 7421`,
      calls: [
        "--user disable --now pipoca.service",
        "--user daemon-reload",
        "--user enable --now pipoca.service",
      ],
      removed: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
