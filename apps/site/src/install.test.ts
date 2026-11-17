import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "..", "public", "install.sh");
const asset = `pipoca-${process.platform}-${process.arch}`;
const release = `#!/bin/sh\necho "pipoca ran: $*"\n`;

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
});

async function install(
  sums: string,
  path?: string,
): Promise<{
  readonly code: number;
  readonly output: string;
  readonly installed: boolean;
}> {
  const releases = Bun.serve({
    port: 0,
    fetch: (request) => {
      const files = new Map([
        [`/v1.2.3/${asset}`, release],
        ["/v1.2.3/SHA256SUMS", sums],
      ]);

      const file = files.get(new URL(request.url).pathname);

      return new Response(file ?? "not found", {
        status: file === undefined ? 404 : 200,
      });
    },
  });

  const home = await mkdtemp(join(tmpdir(), "pipoca-install-"));

  cleanups.push(
    async () => releases.stop(true),
    async () => rm(home, { recursive: true }),
  );

  const bin = join(home, "bin");

  const run = Bun.spawn(
    ["sh", "-s", "--", "agent", "--server", "https://pipoca.example"],
    {
      stdin: Bun.file(script),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...(path !== undefined && { PATH: path }),
        HOME: home,
        PIPOCA_RELEASES: `http://127.0.0.1:${String(releases.port)}`,
        PIPOCA_VERSION: "v1.2.3",
        PIPOCA_BIN_DIR: bin,
      },
    },
  );

  const [code, stdout, stderr] = await Promise.all([
    run.exited,
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);

  return {
    code,
    output: stdout + stderr,
    installed: existsSync(join(bin, "pipoca")),
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

test("installs the release for this system and runs the command after --", async () => {
  const result = await install(`${sha256(release)}  ${asset}\n`);

  expect(result).toMatchObject({ code: 0, installed: true });

  expect(result.output).toContain(
    "pipoca ran: agent --server https://pipoca.example",
  );
});

test("refuses a download that doesn't match the release's SHA256SUMS", async () => {
  const result = await install(`${sha256("something else")}  ${asset}\n`);

  expect(result).toMatchObject({ code: 1, installed: false });
  expect(result.output).toContain("doesn't match the release's SHA256SUMS");
});

test("says when this machine lacks git or npm, which Sessions need", async () => {
  const tools = await mkdtemp(join(tmpdir(), "pipoca-tools-"));
  cleanups.push(async () => rm(tools, { recursive: true }));
  await mkdir(tools, { recursive: true });

  const needed = [
    "sh",
    "uname",
    "curl",
    "mktemp",
    "rm",
    "awk",
    "sha256sum",
    "chmod",
    "mkdir",
    "mv",
  ];

  await Promise.all(
    needed.map(async (tool) => {
      const found = Bun.which(tool);

      if (found !== null) {
        await symlink(found, join(tools, tool));
      }
    }),
  );

  const result = await install(`${sha256(release)}  ${asset}\n`, tools);

  expect(result).toMatchObject({ code: 0, installed: true });
  expect(result.output).toContain("Sessions on this machine need git");
  expect(result.output).toContain("Sessions on this machine need npm");
});
