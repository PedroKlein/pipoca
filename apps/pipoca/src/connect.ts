import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Log } from "@pipoca/providers";
import { runAgent } from "./agent";
import { openInBrowser } from "./browser";

export interface ConnectOptions {
  // What ssh connects to, such as user@vm or a Host from ~/.ssh/config.
  readonly host: string;
  readonly remotePort: number;
  readonly localPort: number;
  // The pipoca binary on the remote machine, for when it isn't on the PATH
  // a non-interactive SSH shell gets.
  readonly remoteCommand: string;
  // This machine's runner name and its Environment's on the server.
  readonly name: string;
  readonly folders: readonly string[];
  readonly dataDir: string;
  readonly open: boolean;
  readonly log: Log;
  readonly signal: AbortSignal;
}

const longestWaitMs = 30_000;

// Holds an SSH tunnel to a solo server on another machine, runs this machine
// as a runner through it, and opens the browser signed in (ADR 0053). Only
// the server's own system user gets a link or a runner token, through its
// socket, so SSH as that user is all the sign-in it needs.
export async function connect(options: ConnectOptions): Promise<void> {
  const local = `http://127.0.0.1:${String(options.localPort)}`;
  const tunnelStop = new AbortController();

  const tunnel = holdTunnel(
    options,
    AbortSignal.any([options.signal, tunnelStop.signal]),
  );

  try {
    await reachable(local, options.signal);

    const token = await remote(options, ["link", "--runner", options.name]);

    if (options.open) {
      const link = new URL(await remote(options, ["link"]));
      openInBrowser(new URL(link.pathname, local).href);
    }

    await runAgent({
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

async function remote(
  options: ConnectOptions,
  args: readonly string[],
): Promise<string> {
  const run = Bun.spawn(["ssh", options.host, options.remoteCommand, ...args], {
    stdio: ["ignore", "pipe", "inherit"],
  });

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
