import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binaryVolume, containerSession, type Docker } from "./container";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "container-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("runs a Session in its image as this user, with its paths, binary and variable names", async () => {
  await mkdir(join(root, "logins"));

  const container = await containerSession({
    sessionId: "s1",
    generation: 2,
    image: "debian:bookworm",
    binary: { file: "/opt/pipoca-linux" },
    folders: [root, join(root, "missing")],
    session: {
      cwd: "/code/app",
      checkouts: [{ path: "/code/app", base: null }],
      agentDir: join(root, "profiles", "p1"),
      sessionDir: join(root, "sessions", "s1"),
      authPath: join(root, "logins", "auth.json"),
      modelsPath: join(root, "logins", "models.json"),
      extensionPaths: ["/ext/tool.ts", "npm:pi-goal"],
      trusted: null,
      systemPrompt: null,
      docsDir: join(root, "docs"),
    },
    variables: { TOKEN: "s3cret" },
  });

  const run = container.run.join(" ");
  const bind = (path: string): string => `type=bind,src=${path},dst=${path}`;

  expect(container.name).toBe("pi-session-s1-2");
  expect(run).toContain(bind("/code/app"));
  expect(run).toContain(bind(root));
  expect(run).toContain(bind(join(root, "profiles", "p1")));
  expect(run).toContain(bind(join(root, "sessions", "s1")));
  expect(run).toContain(bind(join(root, "logins")));
  expect(run).toContain(`${bind("/ext/tool.ts")},readonly`);
  expect(run).toContain(`${bind(join(root, "docs"))},readonly`);

  expect(run).toContain(
    "type=bind,src=/opt/pipoca-linux,dst=/usr/local/bin/pipoca,readonly",
  );

  expect(run).not.toContain("missing");
  expect(run).not.toContain("auth.json");
  expect(run).not.toContain("npm:pi-goal");
  expect(run).toContain("-e TOKEN ");
  expect(run).toContain(`--user ${String(process.getuid?.())}:`);

  expect(run).toEndWith(
    "-w /code/app --entrypoint /usr/local/bin/pipoca debian:bookworm session",
  );

  expect(run).not.toContain("s3cret");
  expect(container.shell).toContain("pi-session-s1-2");
  expect(container.kill).toEqual(["docker", "kill", "pi-session-s1-2"]);

  expect((await stat(join(root, "sessions", "s1", "home"))).isDirectory()).toBe(
    true,
  );
});

test("runs a Session on the binary in a volume, as runner pods do", async () => {
  const container = await containerSession({
    sessionId: "s1",
    generation: 1,
    image: "debian:bookworm",
    binary: { volume: "pipoca-0123456789ab" },
    folders: [],
    session: {
      cwd: "/code/app",
      agentDir: join(root, "profiles", "p1"),
      sessionDir: join(root, "sessions", "s1"),
      authPath: join(root, "logins", "auth.json"),
      modelsPath: join(root, "logins", "models.json"),
      extensionPaths: [],
      trusted: null,
      systemPrompt: null,
    },
    variables: {},
  });

  const run = container.run.join(" ");

  expect(run).toContain(
    "type=volume,src=pipoca-0123456789ab,dst=/opt/pipoca,readonly",
  );

  expect(run).toEndWith(
    "--entrypoint /opt/pipoca/pipoca debian:bookworm session",
  );
});

test("pulls the Pipoca image once and copies its binary into a volume named after it", async () => {
  const calls: string[] = [];
  let pulled = false;

  const answer = (args: readonly string[]): string | undefined => {
    if (args[0] === "pull") {
      pulled = true;
    }

    if (args[0] !== "image") {
      return "";
    }

    return pulled ? "sha256:0123456789abcdef\n" : undefined;
  };

  const docker: Docker = async (args) => {
    calls.push(args.join(" "));
    const output = answer(args);

    return Promise.resolve(
      output === undefined
        ? { code: 1, output: "No such image" }
        : { code: 0, output },
    );
  };

  const volume = await binaryVolume("ghcr.io/pedroklein/pipoca:v1.2.3", docker);

  expect(volume).toBe("pipoca-0123456789ab");
  expect(calls).toContain("pull ghcr.io/pedroklein/pipoca:v1.2.3");

  const copy = calls.find((call) => call.startsWith("run "));
  expect(copy).toContain("type=volume,src=pipoca-0123456789ab,dst=/out");
  expect(copy).toContain("cp /usr/local/bin/pipoca /out/pipoca.part");
});

test("names --session-binary when the Pipoca image can't be pulled", async () => {
  const docker: Docker = async (args) =>
    Promise.resolve({
      code: 1,
      output: args[0] === "pull" ? "manifest unknown" : "No such image",
    });

  const failure = await binaryVolume(
    "ghcr.io/pedroklein/pipoca:v0.0.1",
    docker,
  ).catch((error: unknown) => error);

  expect(String(failure)).toMatch(/manifest unknown.*--session-binary/);
});
