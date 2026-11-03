import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The product was called Pi Cloud before ADR 0042. Its folder stays where it
// is, since the database and git worktrees hold absolute paths into it.
export function dataFolder(): string {
  const root = join(homedir(), ".pipoca");
  const old = join(homedir(), ".pi-cloud");

  return !existsSync(root) && existsSync(old) ? old : root;
}

const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);

// A machine keeps each server's data apart (ADR 0063). A runner for the
// machine's own server uses root/agent, and one for another server uses
// root/servers/<host>. A runner that already ran in root/agent for that
// server stays there, since its worktrees hold absolute paths into it.
export function runnerFolder(root: string, server: string): string {
  const { hostname, host } = new URL(server);
  const own = join(root, "agent");

  if (loopback.has(hostname) || savedServer(own) === server) {
    return own;
  }

  return join(root, "servers", folderName(host));
}

// What `pipoca connect` runs on this machine for the server on an SSH host,
// which it reaches through a tunnel to a loopback address. A machine that
// connected before keeps its one folder.
export function connectFolder(root: string, sshHost: string): string {
  const old = join(root, "connect");
  const host = sshHost.split("@").at(-1) ?? sshHost;
  const folder = join(root, "servers", folderName(host));

  return existsSync(old) && !existsSync(folder) ? old : folder;
}

function folderName(host: string): string {
  return host.replace(/[^A-Za-z0-9.-]/g, "_");
}

function savedServer(folder: string): unknown {
  try {
    const saved: unknown = JSON.parse(
      readFileSync(join(folder, "runner.json"), "utf8"),
    );

    return typeof saved === "object" && saved !== null && "server" in saved
      ? saved.server
      : undefined;
  } catch {
    return undefined;
  }
}
