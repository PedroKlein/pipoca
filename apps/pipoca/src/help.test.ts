import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { version } from "../package.json";

function pipoca(...args: string[]) {
  const run = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "main.ts"), ...args],
    { encoding: "utf8" },
  );

  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

test("lists pipoca's commands for -h, --help and help", () => {
  for (const flag of ["-h", "--help", "help"]) {
    const run = pipoca(flag);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`Pipoca ${version}`);
    expect(run.stdout).toMatch(/^ {2}up +run Pipoca for yourself/m);
    expect(run.stdout).toMatch(/^ {2}connect +use Pipoca on another machine/m);
    expect(run.stdout).not.toContain("AI coding assistant");
  }
});

test("explains one command and its options", () => {
  for (const args of [
    ["up", "--help"],
    ["help", "up"],
    ["up", "-h"],
  ]) {
    const run = pipoca(...args);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("usage: pipoca up [options]");
    expect(run.stdout).toMatch(/^ {2}--folder <path> +a folder Sessions/m);
    expect(run.stdout).toContain("cd ~/code && pipoca up");
  }

  expect(pipoca("service", "install", "up", "--help").stdout).toContain(
    "pipoca service uninstall",
  );
});

test("prints pipoca's own version", () => {
  const run = pipoca("--version");

  expect([run.status, run.stdout]).toEqual([0, `${version}\n`]);
});

test("points a mistyped command to the help", () => {
  const unknown = pipoca("upp");
  const topic = pipoca("help", "upp");

  expect(unknown.status).toBe(2);
  expect(unknown.stderr).toContain("pipoca: unknown command upp");
  expect(unknown.stderr).toContain("commands:");
  expect(topic.status).toBe(2);
  expect(topic.stderr).toContain("pipoca: unknown command upp");
});
