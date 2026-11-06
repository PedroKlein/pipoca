import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { SessionOptions } from "@pipoca/sessionhost";

// Where a container Session finds the runner's Linux pipoca binary: a file
// on this machine, or a Docker volume holding one copied out of the Pipoca
// image, as runner pods get theirs.
const binaryInContainer = "/usr/local/bin/pipoca";
const volumeInContainer = "/opt/pipoca";

// Each release publishes its image as v<version>.
export const pipocaImage = "ghcr.io/pedroklein/pipoca";

export type SessionBinary =
  { readonly file: string } | { readonly volume: string };

export interface ContainerSession {
  readonly name: string;
  // Starts the Session's Pi process in its container, reading the spec on
  // stdin like `pipoca session`.
  readonly run: readonly string[];
  readonly kill: readonly string[];
  // A shell in the running container, for the Session's terminals.
  readonly shell: readonly string[];
}

// A container Session runs the runner's own binary, mounted into any image
// with glibc, bash and git, as the runner's user. It sees only what it needs:
// its workspace, the listed folders its worktrees belong to, its Profile
// folder, its own Session folder, the machine's logins folder, the docs and
// local extensions.
// Paths are mounted at the same place, so the Session's spec needs no
// rewriting (ADR 0032).
export async function containerSession(options: {
  readonly sessionId: string;
  readonly generation: number;
  readonly image: string;
  readonly binary: SessionBinary;
  readonly folders: readonly string[];
  readonly session: Omit<SessionOptions, "models">;
  readonly variables: Readonly<Record<string, string>>;
}): Promise<ContainerSession> {
  const { session } = options;
  const name = `pi-session-${options.sessionId}-${String(options.generation)}`;
  const home = join(session.sessionDir, "home");
  await mkdir(home, { recursive: true });

  // A bind mount of a missing path fails, so the logins and folders count
  // only once they exist.
  const writable = [
    session.cwd,
    ...(session.checkouts ?? []).map(({ path }) => path),
    session.agentDir,
    session.sessionDir,
    ...(await existing([
      ...options.folders.map(expanded),
      dirname(session.authPath),
      dirname(session.modelsPath),
    ])),
  ];

  const readOnly = [
    ...session.extensionPaths.filter(isAbsolute),
    ...(session.docsDir === undefined ? [] : [session.docsDir]),
  ];

  // Values come from the docker client's environment, so they stay out of
  // the process list.
  const variables = [
    ...Object.keys(options.variables).flatMap((key) => ["-e", key]),
    "-e",
    `HOME=${home}`,
  ];

  return {
    name,
    run: [
      "docker",
      "run",
      "-i",
      "--rm",
      "--init",
      ...(process.platform === "linux" ? ["--network", "host"] : []),
      "--name",
      name,
      ...user(),
      ...variables,
      ...[...new Set(writable)].flatMap((path) => bind(path, false)),
      ...[...new Set(readOnly)].flatMap((path) => bind(path, true)),
      ...mountBinary(options.binary),
      "-w",
      session.cwd,
      "--entrypoint",
      "file" in options.binary
        ? binaryInContainer
        : `${volumeInContainer}/pipoca`,
      options.image,
      "session",
    ],
    kill: ["docker", "kill", name],
    shell: [
      "docker",
      "exec",
      "-it",
      ...user(),
      ...variables,
      "-w",
      session.cwd,
      name,
      "bash",
      "-i",
    ],
  };
}

function mountBinary(binary: SessionBinary): readonly string[] {
  return "file" in binary
    ? bind(binary.file, true, binaryInContainer)
    : [
        "--mount",
        `type=volume,src=${binary.volume},dst=${volumeInContainer},readonly`,
      ];
}

export type Docker = (
  args: readonly string[],
) => Promise<{ readonly code: number; readonly output: string }>;

// The volume of the image's pipoca binary, named after the image's ID so a
// new image gets a new volume. It is copied once, through a temporary name,
// so a Session never starts on half a binary.
export async function binaryVolume(
  image: string,
  docker: Docker = runDocker,
): Promise<string> {
  const inspect = async (): Promise<string | undefined> => {
    const { code, output } = await docker([
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      image,
    ]);

    return code === 0 ? output.trim() : undefined;
  };

  let id = await inspect();

  if (id === undefined) {
    const pulled = await docker(["pull", image]);

    if (pulled.code !== 0) {
      throw new Error(
        `container Sessions copy pipoca from ${image}, which Docker couldn't pull: ${pulled.output.trim()}. Start the agent with --session-binary instead`,
      );
    }

    id = await inspect();
  }

  const volume = `pipoca-${(id ?? "").replace(/^sha256:/, "").slice(0, 12)}`;

  const copied = await docker([
    "run",
    "--rm",
    "--user",
    "0",
    "--mount",
    `type=volume,src=${volume},dst=/out`,
    "--entrypoint",
    "sh",
    image,
    "-c",
    "test -x /out/pipoca || { cp /usr/local/bin/pipoca /out/pipoca.part && mv /out/pipoca.part /out/pipoca; }",
  ]);

  if (copied.code !== 0) {
    throw new Error(
      `couldn't copy pipoca out of ${image}: ${copied.output.trim()}`,
    );
  }

  return volume;
}

const runDocker: Docker = async (args) => {
  const child = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { code, output: code === 0 ? out : err };
};

// --mount takes paths with a colon, which -v splits on.
function bind(
  path: string,
  readOnly: boolean,
  target = path,
): readonly string[] {
  return [
    "--mount",
    `type=bind,src=${path},dst=${target}${readOnly ? ",readonly" : ""}`,
  ];
}

function expanded(folder: string): string {
  return resolve(
    folder === "~" || folder.startsWith("~/")
      ? join(homedir(), folder.slice(1))
      : folder,
  );
}

async function existing(paths: readonly string[]): Promise<string[]> {
  const found = await Promise.all(
    paths.map(async (path) =>
      stat(path).then(
        () => path,
        () => undefined,
      ),
    ),
  );

  return found.filter((path) => path !== undefined);
}

function user(): readonly string[] {
  const uid = process.getuid?.();
  const gid = process.getgid?.();

  return uid === undefined || gid === undefined
    ? []
    : ["--user", `${String(uid)}:${String(gid)}`];
}

// Docker Desktop runs containers in a VM, where the runner's own localhost
// is host.docker.internal.
export function serverInContainer(server: string): string {
  if (process.platform === "linux") {
    return server;
  }

  const url = new URL(server);
  if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    url.hostname = "host.docker.internal";
  }

  return url.href.replace(/\/$/, "");
}
