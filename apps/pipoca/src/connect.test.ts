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
import { version } from "../package.json";

const main = join(import.meta.dirname, "main.ts");
const bunfig = join(import.meta.dirname, "..", "..", "..", "bunfig.toml");

// Stands in for ssh on one machine: -N -L forwards the port, anything else
// runs the remote command here. Like a host with ControlMaster in its
// ~/.ssh/config, a tunnel that may share a connection hands its forward to
// the master and exits at once.
const fakeSsh = `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("-N") && !args.includes("ControlPath=none")) {
  process.exit(0);
}
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
  const run = Bun.spawn(command, { stdio: ["inherit", "inherit", "inherit"] });
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

async function listening(server: { readonly stderr: Readable }): Promise<URL> {
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
    `#!/bin/sh\nexec ${process.execPath} ${main} "$@"\n`,
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
        "--remote-database",
        database,
        "--name",
        "laptop",
        "--data-dir",
        join(root, "connect"),
        "--folder",
        root,
        "--print-link",
      ],
      {
        env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );

    running.push(connecting);

    // Printed for whatever ran connect, such as the desktop app, and good
    // through the tunnel.
    const url = await new Promise<string>((resolve) => {
      createInterface({ input: connecting.stderr }).on("line", (line) => {
        const found = /sign in at (\S+)/.exec(line);
        if (found?.[1] !== undefined) {
          resolve(found[1]);
        }
      });
    });

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
      link: new URL(url).port,
    }).toEqual({
      online: true,
      folders: [root],
      tunnel: true,
      link: String(localPort),
    });

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

// A host with no pipoca gets this version's release and runs it as a
// service (ADR 0055). The stand-in release starts the server the service
// would.
test("connect installs pipoca from its release on a host without one, starts it and signs in", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pipoca-install-")));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const database = join(root, "remote", "server.db");
  await mkdir(bin);
  await mkdir(home);
  await executable(join(bin, "ssh"), fakeSsh);

  const release = `#!/bin/sh
if [ "$1" = service ]; then
  shift 3
  ${process.execPath} ${main} server --solo "$@" >/dev/null 2>&1 &
  echo $! > ${join(root, "server.pid")}
  exit 0
fi
exec ${process.execPath} ${main} "$@"
`;

  const downloads: string[] = [];

  const releases = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      downloads.push(new URL(request.url).pathname);

      return new Response(release);
    },
  });

  const remotePort = await freePort();
  const localPort = await freePort();

  const connecting = spawn(
    process.execPath,
    [
      main,
      "connect",
      "me@vm",
      "--port",
      String(remotePort),
      "--local-port",
      String(localPort),
      "--remote-pipoca",
      "pipoca-that-is-not-installed",
      "--remote-database",
      database,
      "--name",
      "laptop",
      "--data-dir",
      join(root, "connect"),
      "--folder",
      root,
      "--print-link",
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        PIPOCA_RELEASES: releases.url.href.replace(/\/$/, ""),
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );

  try {
    const url = await new Promise<string>((resolve) => {
      createInterface({ input: connecting.stderr }).on("line", (line) => {
        const found = /sign in at (\S+)/.exec(line);
        if (found?.[1] !== undefined) {
          resolve(found[1]);
        }
      });
    });

    const signedIn = await fetch(url, { redirect: "manual" });
    const installed = await stat(join(home, ".pipoca", "bin", "pipoca"));

    const platform = `${process.platform}-${process.arch}`;

    expect({
      downloads,
      signedIn: signedIn.status,
      executable: (installed.mode & 0o100) !== 0,
    }).toEqual({
      downloads: [`/v${version}/pipoca-${platform}`],
      signedIn: 303,
      executable: true,
    });
  } finally {
    connecting.kill("SIGKILL");
    await releases.stop(true);

    const pid = await readFile(join(root, "server.pid"), "utf8").catch(
      () => "",
    );

    if (pid !== "") {
      process.kill(Number(pid), "SIGKILL");
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
      execStart: `ExecStart=${process.execPath} --config=${bunfig} ${main} server --solo --folder ${root} --port 7421`,
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

test("service uninstall says so when no service is installed", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pipoca-service-")));
  const bin = join(root, "bin");
  await mkdir(bin);
  await executable(join(bin, "systemctl"), "#!/bin/sh\n");
  await executable(join(bin, "launchctl"), "#!/bin/sh\n");

  try {
    const child = spawn(process.execPath, [main, "service", "uninstall"], {
      env: {
        ...process.env,
        HOME: root,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      },
      stdio: ["ignore", "pipe", "ignore"],
    });

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += String(chunk)));

    const [code] = (await once(child, "exit")) as [number | null];

    expect({ code, output }).toEqual({
      code: 0,
      output: "no service installed\n",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
