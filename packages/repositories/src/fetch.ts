import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { InvalidRepository } from "./manifest";

export interface Clone {
  readonly dir: string;
  readonly commit: string;
}

export interface CloneOptions {
  readonly local?: boolean;
  // A curl resolve entry, host:port:address, so git connects only to the
  // address the server checked.
  readonly resolve?: string;
}

const timeoutMs = 2 * 60_000;
const maxTarballBytes = 100 * 1024 * 1024;
const execFiled = promisify(execFile);

// The server fetches with its own git setup: only remote https and ssh URLs,
// and file URLs where the caller allows local sources, with no stored
// credentials. Every user sees where something came from, so a URL holds
// none either.
function trusted(url: string, local: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidRepository(`${url} isn't a URL`);
  }

  const protocols = local ? ["https:", "ssh:", "file:"] : ["https:", "ssh:"];

  if (!protocols.includes(parsed.protocol) || /\s/.test(url)) {
    throw new InvalidRepository(
      local
        ? "url must be an https, ssh or file URL"
        : "url must be an https:// or ssh:// git URL",
    );
  }

  if (
    parsed.password !== "" ||
    (parsed.username !== "" && parsed.protocol !== "ssh:")
  ) {
    throw new InvalidRepository(
      "a URL can't hold credentials; use an ssh URL with a key for a private repository",
    );
  }

  return parsed;
}

// A shallow copy of the repository at the ref after #, or its default
// branch, removed after use.
export async function withClone<T>(
  url: string,
  work: (clone: Clone) => Promise<T> | T,
  options: CloneOptions = {},
): Promise<T> {
  const parsed = trusted(url, options.local === true);
  const dir = await mkdtemp(join(tmpdir(), "pipoca-repository-"));

  try {
    const commit = await fetchGit(parsed, dir, options.resolve).catch(
      (error: unknown) => {
        throw new InvalidRepository(`could not clone ${url}: ${String(error)}`);
      },
    );

    return await work({ dir, commit });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Fills the folder `into` with a repository's files, without its history,
// or with a .tgz's one folder. The exact version fetched: a git commit, or
// the tarball's SHA-256.
export async function fetchSnapshot(
  url: string,
  into: string,
): Promise<string> {
  const parsed = trusted(url, true);

  let pinned: string;

  if (isTarball(parsed)) {
    pinned = await fromTarball(parsed, into);
  } else {
    await mkdir(into);
    pinned = await fetchGit(parsed, into);
    await rm(join(into, ".git"), { recursive: true, force: true });
  }

  await refuseLinks(into);

  return pinned;
}

// The commit a git URL's ref points at now. Undefined for a tarball, or for
// a ref the repository doesn't list, such as a commit.
export async function latestCommit(url: string): Promise<string | undefined> {
  const parsed = trusted(url, true);

  if (isTarball(parsed)) {
    return undefined;
  }

  const { repository, ref } = refOf(parsed);

  const listed = (
    await git(["ls-remote", "--", repository, ref, `${ref}^{}`], tmpdir())
  )
    .split("\n")
    .flatMap((line) => {
      const [commit, name] = line.split("\t");

      return commit !== undefined && name !== undefined
        ? [{ commit, name }]
        : [];
    });

  // An annotated tag's own line names the tag object; ^{} is its commit.
  const peeled = listed.find(({ name }) => name.endsWith("^{}"));

  return peeled?.commit ?? listed[0]?.commit;
}

function isTarball(url: URL): boolean {
  return /\.(tgz|tar\.gz)$/.test(url.pathname);
}

function refOf(url: URL): {
  readonly repository: string;
  readonly ref: string;
} {
  const repository = new URL(url);
  repository.hash = "";

  return {
    repository: repository.href,
    ref: decodeURIComponent(url.hash.slice(1)) || "HEAD",
  };
}

async function fetchGit(
  url: URL,
  into: string,
  resolve?: string,
): Promise<string> {
  const { repository, ref } = refOf(url);

  const pinned =
    resolve === undefined ? [] : ["-c", `http.curloptResolve=${resolve}`];

  await git(["init", "-q"], into);

  await git(
    [...pinned, "fetch", "-q", "--depth", "1", "--", repository, ref],
    into,
  );

  await git(["checkout", "-q", "FETCH_HEAD"], into);

  return (await git(["rev-parse", "HEAD"], into)).trim();
}

// A link could point the server's own writes and reads at any file it can
// reach.
async function refuseLinks(folder: string): Promise<void> {
  const entries = await readdir(folder, {
    recursive: true,
    withFileTypes: true,
  });

  const link = entries.find((entry) => entry.isSymbolicLink());

  if (link !== undefined) {
    throw new InvalidRepository(
      `it holds a link, ${relative(folder, join(link.parentPath, link.name))}, which something fetched from a URL can't`,
    );
  }
}

// A tarball holds one folder, as npm pack and GitHub's archives make them.
async function fromTarball(url: URL, into: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });

  if (!response.ok) {
    throw new InvalidRepository(
      `fetching ${url.href} answered ${String(response.status)}`,
    );
  }

  const bytes = await capped(response);
  const archive = `${into}.tgz`;
  const unpacked = `${into}.unpacked`;

  try {
    await writeFile(archive, bytes);
    await mkdir(unpacked);

    // GNU and BSD tar both refuse members that climb out with .. or through
    // a link the archive made.
    await run(
      "tar",
      [
        "-xzf",
        archive,
        "--no-same-owner",
        "--no-same-permissions",
        "-C",
        unpacked,
      ],
      unpacked,
    );

    const entries = await readdir(unpacked, { withFileTypes: true });
    const [top] = entries;

    if (entries.length !== 1 || top?.isDirectory() !== true) {
      throw new InvalidRepository("a tarball must hold one folder");
    }

    await rename(join(unpacked, top.name), into);
  } finally {
    await rm(archive, { force: true });
    await rm(unpacked, { recursive: true, force: true });
  }

  return `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
}

async function capped(response: Response): Promise<Uint8Array> {
  const tooBig = new InvalidRepository(
    `a tarball can be at most ${String(maxTarballBytes / 1024 / 1024)} MB`,
  );

  if (Number(response.headers.get("content-length")) > maxTarballBytes) {
    throw tooBig;
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();

  for (;;) {
    const read = await reader?.read();

    if (read === undefined || read.done) {
      break;
    }

    const chunk = read.value as Uint8Array;
    size += chunk.byteLength;

    if (size > maxTarballBytes) {
      await reader?.cancel();
      throw tooBig;
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function git(args: readonly string[], cwd: string): Promise<string> {
  return run(
    "git",
    [
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always",
      "-c",
      "protocol.ssh.allow=always",
      "-c",
      "protocol.file.allow=always",
      "-c",
      "credential.helper=",
      ...args,
    ],
    cwd,
    `git ${args[0] ?? ""}`,
  );
}

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  label = command,
): Promise<string> {
  try {
    const { stdout } = await execFiled(command, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      // Nobody is there to answer a password or host key prompt.
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
      },
    });

    return stdout;
  } catch (error) {
    throw new InvalidRepository(failure(command, label, error));
  }
}

function failure(command: string, label: string, error: unknown): string {
  const { code, killed } = error as {
    code?: unknown;
    killed?: boolean;
  };

  if (code === "ENOENT") {
    return `${command} isn't installed on this server`;
  }

  if (killed === true) {
    return `${label} took longer than ${String(timeoutMs / 60_000)} minutes`;
  }

  // What git said can describe hosts the person can't reach themselves.
  return `${label} failed. Check that the URL is right and that the server may read the repository.`;
}
