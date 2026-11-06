import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineSession, type SessionContext } from "@pipoca/plugins";
import { gitHosts } from "../plugin";
import type { Identity } from "./commit-as";

const run = promisify(execFile);

// Watches the pull requests /pr opens (ADR 0051). /pr records each one in
// its checkout's git config, under branch.<name>.pipocaPullRequest.
export const session = defineSession(gitHosts, (s) => {
  s.extension((pi) => {
    const watched = new Set<string>();

    const watchRecorded = async (): Promise<void> => {
      for (const url of await recordedPullRequests(s)) {
        if (watched.has(url)) {
          continue;
        }

        watched.add(url);

        await s.api.post("pull-requests", { url }).catch((failure: unknown) => {
          watched.delete(url);

          s.log("could not watch a pull request", {
            url,
            error: String(failure),
          });
        });
      }
    };

    const check = (): void => {
      watchRecorded().catch((failure: unknown) => {
        s.log("could not read recorded pull requests", {
          error: String(failure),
        });
      });
    };

    pi.on("session_start", () => {
      check();

      signCommits(s).catch((failure: unknown) => {
        s.log("could not set the Session's git identity", {
          error: String(failure),
        });
      });
    });

    pi.on("agent_settled", check);
  });
});

type Context = SessionContext<typeof gitHosts>;

async function recordedPullRequests({
  checkouts,
}: Context): Promise<readonly string[]> {
  const found = await Promise.all(
    checkouts.map(async ({ path }) => {
      const { stdout } = await run("git", [
        "-C",
        path,
        "config",
        "--get-regexp",
        String.raw`^branch\..*\.pipocapullrequest$`,
      ]).catch(() => ({ stdout: "" }));

      return stdout.split("\n").flatMap((line) => {
        const url = line.split(" ").slice(1).join(" ").trim();

        return url === "" ? [] : [url];
      });
    }),
  );

  return found.flat();
}

// A Session commits as the technical user it acts as (ADR 0060), or as the
// name and email its person chose.
async function signCommits({ api, checkouts }: Context): Promise<void> {
  const identity = await api.get<Identity | null>("identity");

  if (identity === null) {
    return;
  }

  await Promise.all(
    checkouts.map(async ({ path }) => {
      await run("git", ["-C", path, "config", "user.name", identity.name]);
      await run("git", ["-C", path, "config", "user.email", identity.email]);
    }),
  );
}
