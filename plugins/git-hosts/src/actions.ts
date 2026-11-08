import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ServerContext } from "@pipoca/plugins";
import type { GitLogin, Owner, Session } from "@pipoca/protocol";
import type { gitHosts } from "../plugin";
import { reach } from "./github";
import type { HostConfig, Hosts } from "./hosts";

const run = promisify(execFile);

const pushTimeoutMs = 5 * 60_000;

interface Target {
  readonly host: HostConfig;
  readonly repository: string;
  readonly token: string;
}

// The actions a routine's run proposes on a git host (ADR 0076), written
// with the token of the identity the run acts as (ADR 0060).
export function hostActions(
  context: Pick<ServerContext<typeof gitHosts>, "provide" | "log">,
  hosts: Hosts,
  loginsOf: (
    owner: Owner,
    session: Pick<Session, "actsAs" | "proposes" | "workspace">,
  ) => readonly GitLogin[],
  watch: (session: Session, url: string) => void,
): void {
  const targetOf = (session: Session, repository?: string): Target => {
    const named = repository ?? repositoryOf(session.workspace) ?? "";

    const match =
      /^(?:https?:\/\/([^/]+)\/)?([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(
        named.trim(),
      );

    const workspaceHost = /^https?:\/\/([^/]+)\//.exec(
      repositoryOf(session.workspace) ?? "",
    )?.[1];

    const listed = hosts.list();

    const name =
      match?.[1] ??
      workspaceHost ??
      (listed.length === 1 ? listed[0]?.host : undefined);

    const host = name === undefined ? undefined : hosts.get(name.toLowerCase());

    if (match?.[2] === undefined || host === undefined) {
      throw new Error(`${named} isn't a repository on one of the git hosts`);
    }

    const token = loginsOf(session.ownedBy, session).find(
      (each) => each.host === host.host,
    )?.token;

    if (token === undefined) {
      throw new Error(`the run has no login on ${host.host} to write with`);
    }

    return { host, repository: match[2], token };
  };

  const call = async (
    { host, repository, token }: Target,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Readonly<Record<string, unknown>>> => {
    const response = await reach(
      host,
      `${host.api}/repos/${repository}${path}`,
      {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      },
    );

    const answer: unknown = await response.json().catch(() => ({}));

    if (!response.ok) {
      const { message } = (answer ?? {}) as { message?: unknown };

      throw new Error(
        `${host.host} answered ${String(response.status)}${typeof message === "string" ? `: ${message}` : ""}`,
      );
    }

    return Array.isArray(answer)
      ? { items: answer }
      : ((answer ?? {}) as Record<string, unknown>);
  };

  const urlOf = (answer: Readonly<Record<string, unknown>>): string =>
    typeof answer["html_url"] === "string" ? answer["html_url"] : "";

  context.provide.actions({
    pullRequest: async (input, { session, commits }) => {
      const { workspace } = session;

      if (!("branch" in workspace) || commits === undefined) {
        throw new Error("the run's workspace has no branch to push");
      }

      const target = targetOf(session);
      const remote = repositoryOf(workspace) ?? "";

      await pushBundle(commits, remote, workspace.branch, target);

      const owner = target.repository.split("/")[0] ?? "";

      const { items } = await call(
        target,
        "GET",
        `/pulls?state=open&head=${encodeURIComponent(`${owner}:${workspace.branch}`)}`,
      );

      const [open] = Array.isArray(items) ? (items as unknown[]) : [];

      if (open !== undefined) {
        const url = urlOf(open as Record<string, unknown>);

        return { text: `Pushed to ${url}`, url };
      }

      const repository = await call(target, "GET", "");

      const base =
        input.base ??
        (typeof repository["default_branch"] === "string"
          ? repository["default_branch"]
          : "main");

      const url = urlOf(
        await call(target, "POST", "/pulls", {
          title: input.title,
          body: input.body ?? "",
          head: workspace.branch,
          base,
          draft: input.draft === true,
        }),
      );

      try {
        watch(session, url);
      } catch (error) {
        context.log("could not watch the pull request a run opened", {
          url,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return { text: `Opened ${url}`, url };
    },
    comment: async ({ repository, number, body }, { session }) => {
      const url = urlOf(
        await call(
          targetOf(session, repository),
          "POST",
          `/issues/${String(number)}/comments`,
          { body },
        ),
      );

      return { text: `Commented on #${String(number)}`, url };
    },
    labels: async (
      { repository, number, add = [], remove = [] },
      { session },
    ) => {
      const target = targetOf(session, repository);
      const path = `/issues/${String(number)}/labels`;

      if (add.length > 0) {
        await call(target, "POST", path, { labels: add });
      }

      for (const label of remove) {
        await call(target, "DELETE", `${path}/${encodeURIComponent(label)}`);
      }

      return {
        text: [
          add.length > 0 && `added ${add.join(", ")}`,
          remove.length > 0 && `removed ${remove.join(", ")}`,
        ]
          .filter(Boolean)
          .join(" and ")
          .replace(/^./, (first) => first.toUpperCase()),
      };
    },
    closeIssue: async ({ repository, number, reason }, { session }) => {
      const url = urlOf(
        await call(
          targetOf(session, repository),
          "PATCH",
          `/issues/${String(number)}`,
          { state: "closed", state_reason: reason ?? "completed" },
        ),
      );

      return { text: `Closed #${String(number)}`, url };
    },
    requestReview: async ({ repository, number, reviewers }, { session }) => {
      const url = urlOf(
        await call(
          targetOf(session, repository),
          "POST",
          `/pulls/${String(number)}/requested_reviewers`,
          { reviewers },
        ),
      );

      return {
        text: `Asked ${reviewers.join(", ")} to review #${String(number)}`,
        url,
      };
    },
  });
}

function repositoryOf(workspace: Session["workspace"]): string | undefined {
  switch (workspace.kind) {
    case "clone":
      return workspace.repository;
    case "repositories":
      return workspace.repositories[0]?.repository;
    case "folder":
    case "worktree":
      return undefined;
  }
}

// Pushes the branch a git bundle holds to the remote, as the target's
// identity. A bundle made since the branch's start needs those commits, which
// a shallow fetch brings first.
async function pushBundle(
  bundle: Uint8Array,
  remote: string,
  branch: string,
  target: Target,
): Promise<void> {
  const { prerequisites, refs } = bundleHeader(bundle);
  const ref = `refs/heads/${branch}`;

  if (!refs.includes(ref)) {
    throw new Error(`the commits hold no branch ${branch}`);
  }

  const dir = await mkdtemp(join(tmpdir(), "pipoca-push-"));
  const file = join(dir, "commits.bundle");
  const repo = join(dir, "repo");
  const env = authEnv(target.host.host, target.token);

  const git = async (...args: string[]): Promise<void> => {
    await run("git", args, { env, timeout: pushTimeoutMs });
  };

  try {
    await writeFile(file, bundle);
    await git("init", "--quiet", "--bare", repo);

    for (const sha of prerequisites) {
      await git("-C", repo, "fetch", "--quiet", "--depth=1", remote, sha);
    }

    await git("-C", repo, "fetch", "--quiet", file, `${ref}:${ref}`);
    await git("-C", repo, "push", "--quiet", remote, `${ref}:${ref}`);
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;

    throw new Error(
      `couldn't push ${branch}: ${typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim().replaceAll(target.token, "***") : String(error)}`,
      { cause: error },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A v2 or v3 bundle's header: lines of "-<sha>" for the commits it needs,
// then "<sha> <ref>" for the refs it holds, then an empty line.
function bundleHeader(bundle: Uint8Array): {
  readonly prerequisites: readonly string[];
  readonly refs: readonly string[];
} {
  const end = Buffer.from(bundle).indexOf("\n\n");

  const lines = Buffer.from(bundle.subarray(0, Math.max(end, 0)))
    .toString("utf8")
    .split("\n");

  if (!/^# v[23] git bundle$/.test(lines[0] ?? "")) {
    throw new Error("the commits aren't a git bundle");
  }

  const body = lines.slice(1).filter((line) => !line.startsWith("@"));

  return {
    prerequisites: body.flatMap((line) =>
      line.startsWith("-") ? [line.slice(1).split(" ")[0] ?? ""] : [],
    ),
    refs: body.flatMap((line) =>
      line.startsWith("-") ? [] : [line.split(" ")[1] ?? ""],
    ),
  };
}

// git signs in to the host with the token as a header, so the token is in
// no command line. The entries follow any the server's environment has.
function authEnv(host: string, token: string): NodeJS.ProcessEnv {
  const count = Number(process.env["GIT_CONFIG_COUNT"] ?? 0);
  const first = Number.isSafeInteger(count) && count > 0 ? count : 0;
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");

  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: String(first + 1),
    [`GIT_CONFIG_KEY_${String(first)}`]: `http.https://${host}/.extraheader`,
    [`GIT_CONFIG_VALUE_${String(first)}`]: `AUTHORIZATION: basic ${basic}`,
  };
}
