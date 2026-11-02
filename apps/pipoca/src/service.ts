import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

const label = "dev.pipoca";

// Where the unit lives and the commands that start and stop it, as a
// launchd agent on macOS and a systemd user unit elsewhere (ADR 0053).
interface Manager {
  readonly path: string;
  readonly unit: (command: readonly string[], path: string) => string;
  readonly start: readonly (readonly string[])[];
  readonly stop: readonly (readonly string[])[];
}

function manager(): Manager {
  if (process.platform === "darwin") {
    const path = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
    const domain = `gui/${String(userInfo().uid)}`;

    return {
      path,
      unit: launchdAgent,
      start: [["launchctl", "bootstrap", domain, path]],
      stop: [["launchctl", "bootout", domain, path]],
    };
  }

  return {
    path: join(homedir(), ".config", "systemd", "user", "pipoca.service"),
    unit: systemdUnit,
    start: [
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "pipoca.service"],
    ],
    stop: [["systemctl", "--user", "disable", "--now", "pipoca.service"]],
  };
}

// Runs the command at every login, and again whenever it exits with an
// error. One unit per user: installing again replaces it. It keeps the PATH
// it was installed from, since a login service starts with a bare one that
// misses tools such as docker.
export async function installService(
  command: readonly string[],
): Promise<string> {
  const { path, unit, start, stop } = manager();

  await mkdir(dirname(path), { recursive: true });
  await runAll(stop, false);
  await writeFile(path, unit(command, process.env["PATH"] ?? ""));
  await runAll(start, true);

  return path;
}

export async function uninstallService(): Promise<string> {
  const { path, stop } = manager();

  await runAll(stop, false);
  await rm(path, { force: true });

  return path;
}

async function runAll(
  commands: readonly (readonly string[])[],
  strict: boolean,
): Promise<void> {
  for (const command of commands) {
    const run = Bun.spawn([...command], {
      stdio: ["ignore", "ignore", strict ? "inherit" : "ignore"],
    });

    if ((await run.exited) !== 0 && strict) {
      throw new Error(`${command.join(" ")} failed`);
    }
  }
}

function systemdUnit(command: readonly string[], path: string): string {
  return `[Unit]
Description=Pipoca
After=network-online.target

[Service]
Environment=${systemdWord(`PATH=${path}`)}
ExecStart=${command.map(systemdWord).join(" ")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

// systemd expands % specifiers even inside quotes.
function systemdWord(word: string): string {
  const escaped = word.replaceAll("%", "%%");

  return /^[\w@+=:,./~%-]+$/.test(escaped)
    ? escaped
    : `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function launchdAgent(command: readonly string[], path: string): string {
  const log = join(homedir(), "Library", "Logs", "pipoca.log");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${command.map((word) => `    <string>${xml(word)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

function xml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
