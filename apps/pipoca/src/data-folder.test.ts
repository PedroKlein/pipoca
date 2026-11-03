import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectFolder, runnerFolder } from "./data-folder";

const rootOf = (): string => mkdtempSync(join(tmpdir(), "data-folder-"));

test("keeps a runner for this machine's own server in agent, and another server's in its own folder", () => {
  const root = rootOf();

  expect(runnerFolder(root, "http://127.0.0.1:7420")).toBe(join(root, "agent"));
  expect(runnerFolder(root, "http://localhost:7420")).toBe(join(root, "agent"));

  expect(runnerFolder(root, "https://pipoca.example.com")).toBe(
    join(root, "servers", "pipoca.example.com"),
  );

  expect(runnerFolder(root, "http://10.0.0.5:7420")).toBe(
    join(root, "servers", "10.0.0.5_7420"),
  );
});

test("leaves a runner that already ran for that server in agent", () => {
  const root = rootOf();
  mkdirSync(join(root, "agent"));

  writeFileSync(
    join(root, "agent", "runner.json"),
    JSON.stringify({ server: "https://pipoca.example.com" }),
  );

  expect(runnerFolder(root, "https://pipoca.example.com")).toBe(
    join(root, "agent"),
  );

  expect(runnerFolder(root, "https://other.example.com")).toBe(
    join(root, "servers", "other.example.com"),
  );
});

test("keeps what connect runs per SSH host, unless it connected before", () => {
  const root = rootOf();

  expect(connectFolder(root, "me@my-vm")).toBe(join(root, "servers", "my-vm"));

  mkdirSync(join(root, "connect"));
  expect(connectFolder(root, "me@my-vm")).toBe(join(root, "connect"));

  mkdirSync(join(root, "servers", "other"), { recursive: true });
  expect(connectFolder(root, "other")).toBe(join(root, "servers", "other"));
});
