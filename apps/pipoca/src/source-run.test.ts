import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipoca } from "./binary";

const folder = mkdtempSync(join(tmpdir(), "pipoca-source-"));

const [command = "", ...args] = pipoca;

const server = spawn(
  command,
  [
    ...args,
    "server",
    "--port",
    "0",
    "--database",
    join(folder, "server.db"),
    "--data-dir",
    join(folder, "server"),
  ],
  { cwd: folder, env: { ...process.env, HOME: folder } },
);

afterAll(() => {
  server.kill();
});

// Reads the server's log for as long as it runs, since a server whose log
// nobody reads stops at its next line.
async function listening(): Promise<URL> {
  let output = "";

  return new Promise((resolve, reject) => {
    server.stderr.on("data", (chunk) => {
      output += String(chunk);
      const url = /"server listening","url":"([^"]+)"/.exec(output)?.[1];

      if (url !== undefined) {
        resolve(new URL(url));
      }
    });

    server.on("exit", () => {
      reject(new Error(`the server stopped before listening:\n${output}`));
    });
  });
}

// Started as a service, a server run from source has another working folder,
// where Bun finds no bunfig.toml to build the web UI's styles with.
test("a server run from source outside the repository serves built styles", async () => {
  const url = await listening();
  const page = await (await fetch(url)).text();
  const stylesheet = /href="(\/chunk-[a-z0-9]+\.css)"/.exec(page)?.[1];

  const css = await (await fetch(new URL(stylesheet ?? "", url))).text();

  expect(stylesheet).toBeDefined();
  expect(css.includes(".flex{display:flex}")).toBe(true);
}, 30_000);
