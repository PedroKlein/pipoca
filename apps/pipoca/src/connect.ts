import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Log } from "@pipoca/protocol";
import { version } from "../package.json";
import { runAgent } from "@pipoca/runner";
import { binary } from "./binary";
import { openInBrowser } from "./browser";

interface ConnectOptions {
  // What ssh connects to, such as user@vm or a Host from ~/.ssh/config.
  readonly host: string;
  readonly remotePort: number;
  readonly localPort: number;
  // The pipoca binary on the remote machine, for when it isn't on the PATH
  // a non-interactive SSH shell gets.
  readonly remoteCommand: string;
  // The remote server's database, when it isn't the default, which says
  // where its socket is.
  readonly remoteDatabase?: string;
  // This machine's runner name and its Environment's on the server.
  readonly name: string;
  readonly folders: readonly string[];
  readonly dataDir: string;
  // Whether to open the browser signed in, only print the sign-in link, or
  // neither, as a service at login does.
  readonly signIn: "open" | "print" | "none";
  readonly log: Log;
  readonly signal: AbortSignal;
}

const longestWaitMs = 30_000;

// Holds an SSH tunnel to a solo server on another machine, runs this machine
// as a runner through it, and opens the browser signed in (ADR 0053). Only
// the server's own system user gets a link or a runner token, through its
// socket, so SSH as that user is all the sign-in it needs.
export async function connect(given: ConnectOptions): Promise<void> {
  const options = {
    ...given,
    remoteCommand: await installedPipoca(given),
  };

  const local = `http://127.0.0.1:${String(options.localPort)}`;
  const tunnelStop = new AbortController();

  const tunnel = holdTunnel(
    options,
    AbortSignal.any([options.signal, tunnelStop.signal]),
  );

  try {
    await reachable(local, options.signal);

    const token = await remote(options, ["link", "--runner", options.name]);

    if (options.signIn !== "none") {
      const link = new URL(await remote(options, ["link"]));

      openInBrowser(
        new URL(link.pathname, local).href,
        options.signIn === "print",
      );
    }

    await runAgent({
      binary,
      server: local,
      provider: options.name,
      credential: { token },
      dataDir: join(options.dataDir, options.name),
      extensionPaths: [],
      folders: options.folders,
      log: options.log,
      signal: options.signal,
    });
  } finally {
    tunnelStop.abort();
    await tunnel;
  }
}

// Starts ssh again whenever it exits, waiting longer after each quick exit,
// until the signal stops it.
async function holdTunnel(
  options: ConnectOptions,
  signal: AbortSignal,
): Promise<void> {
  // A call, since the signal changes while ssh runs.
  const stopped = (): boolean => signal.aborted;
  let waitMs = 1000;

  while (!stopped()) {
    const started = Date.now();

    const ssh = Bun.spawn(
      [
        "ssh",
        "-N",
        "-o",
        "ExitOnForwardFailure=yes",
        // A ControlMaster from ~/.ssh/config would take the forward and let
        // this ssh exit, leaving a tunnel it can't watch or restart.
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-L",
        `127.0.0.1:${String(options.localPort)}:127.0.0.1:${String(options.remotePort)}`,
        options.host,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );

    const stop = (): void => {
      ssh.kill("SIGTERM");
    };

    signal.addEventListener("abort", stop);
    options.log("tunnel opened", { host: options.host, pid: ssh.pid });

    const code = await ssh.exited;
    signal.removeEventListener("abort", stop);

    if (stopped()) {
      return;
    }

    waitMs = Date.now() - started > 60_000 ? 1000 : waitMs;

    options.log("tunnel closed", {
      host: options.host,
      code,
      retryInMs: waitMs,
    });

    await sleep(waitMs, undefined, { signal }).catch(() => undefined);

    waitMs = Math.min(waitMs * 2, longestWaitMs);
  }
}

// Where releases are downloaded from: GitHub, unless PIPOCA_RELEASES names a
// mirror.
const releases =
  process.env["PIPOCA_RELEASES"] ??
  "https://github.com/PedroKlein/pipoca/releases/download";

const platforms: Record<string, string> = {
  "Linux x86_64": "linux-x64",
  "Linux aarch64": "linux-arm64",
  "Linux arm64": "linux-arm64",
  "Darwin arm64": "darwin-arm64",
  "Darwin x86_64": "darwin-x64",
};

// The pipoca to run on the host. A host without one gets this version's
// release for its system in ~/.pipoca/bin and runs `up` there as a service,
// as Claude Code installs itself on an SSH host (ADR 0055).
async function installedPipoca(options: ConnectOptions): Promise<string> {
  const found = await remoteScript(
    options,
    `if command -v "$1" >/dev/null 2>&1; then command -v "$1"
elif [ -x "$HOME/.pipoca/bin/pipoca" ]; then echo "$HOME/.pipoca/bin/pipoca"
else echo "missing $(uname -s) $(uname -m)"; fi`,
    [options.remoteCommand],
  );

  if (!found.startsWith("missing ")) {
    return found;
  }

  const system = found.slice("missing ".length);
  const platform = platforms[system];
  if (platform === undefined) {
    throw new Error(
      `${options.host} runs ${system}, which has no pipoca release`,
    );
  }

  const url = `${releases}/v${version}/pipoca-${platform}`;
  options.log("installing pipoca", { host: options.host, url });

  const database =
    options.remoteDatabase === undefined
      ? []
      : ["--database", options.remoteDatabase];

  const installed = await remoteScript(
    options,
    `set -e
bin="$HOME/.pipoca/bin"
mkdir -p "$bin"
curl -fsSL "$1" -o "$bin/pipoca.download"
chmod +x "$bin/pipoca.download"
mv "$bin/pipoca.download" "$bin/pipoca"
shift
"$bin/pipoca" service install up "$@" >&2
echo "$bin/pipoca"`,
    [url, "--port", String(options.remotePort), ...database],
  );

  options.log("installed pipoca", { host: options.host, path: installed });

  return installed;
}

// Runs a shell script on the host, sent on stdin so no shell quoting
// between here and there can change it, and returns its last line.
async function remoteScript(
  options: ConnectOptions,
  script: string,
  args: readonly string[],
): Promise<string> {
  const run = Bun.spawn(["ssh", options.host, "sh", "-s", "--", ...args], {
    stdin: new Blob([script]),
    stdout: "pipe",
    stderr: "inherit",
  });

  const [out, code] = await Promise.all([
    new Response(run.stdout).text(),
    run.exited,
  ]);

  if (code !== 0) {
    throw new Error(
      `a script failed on ${options.host} with code ${String(code)}`,
    );
  }

  return out.trim().split("\n").at(-1) ?? "";
}

async function remote(
  options: ConnectOptions,
  args: readonly string[],
): Promise<string> {
  const database =
    options.remoteDatabase === undefined
      ? []
      : ["--database", options.remoteDatabase];

  const run = Bun.spawn(
    ["ssh", options.host, options.remoteCommand, ...args, ...database],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
  );

  const [out, code] = await Promise.all([
    new Response(run.stdout).text(),
    run.exited,
  ]);

  if (code !== 0) {
    throw new Error(
      `${options.remoteCommand} ${args.join(" ")} failed on ${options.host} with code ${String(code)}`,
    );
  }

  return out.trim();
}

async function reachable(url: string, signal: AbortSignal): Promise<void> {
  const until = Date.now() + 60_000;

  while (Date.now() < until) {
    const answered = await fetch(new URL("/api/auth", url), { signal }).then(
      () => true,
      () => false,
    );

    if (answered || signal.aborted) {
      return;
    }

    await sleep(250);
  }

  throw new Error(`no server answered through the tunnel at ${url}`);
}
