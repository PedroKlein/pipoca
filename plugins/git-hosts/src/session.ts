import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineSession, type SessionContext } from "@pipoca/plugins";
import { gitHosts } from "../plugin";
import type { Identity } from "./model";

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
// name and email its person chose for each checkout's host (ADR 0072).
async function signCommits({ api, checkouts }: Context): Promise<void> {
  const asked = new Map<string, Promise<Identity | null>>();

  const identityOn = async (host: string): Promise<Identity | null> => {
    const known = asked.get(host);

    if (known !== undefined) {
      return known;
    }

    const identity = api.get<Identity | null>(
      "identity",
      host === "" ? {} : { host },
    );

    asked.set(host, identity);

    return identity;
  };

  await Promise.all(
    checkouts.map(async ({ path }) => {
      const identity = await identityOn(await hostOf(path));

      if (identity === null) {
        return;
      }

      await run("git", ["-C", path, "config", "user.name", identity.name]);
      await run("git", ["-C", path, "config", "user.email", identity.email]);
    }),
  );
}

// The host of the checkout's origin, as https, ssh and scp-like URLs name
// it, or empty without one. An https port is part of the host, as the
// config lists it, but an ssh port isn't.
async function hostOf(path: string): Promise<string> {
  const { stdout } = await run("git", [
    "-C",
    path,
    "config",
    "--get",
    "remote.origin.url",
  ]).catch(() => ({ stdout: "" }));

  const url = stdout.trim();

  const match =
    /^https?:\/\/(?:[^@/]*@)?([^/]+)/i.exec(url) ??
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)/i.exec(url) ??
    /^(?:[^@/]*@)?([^/:]+):/.exec(url);

  return match?.[1]?.toLowerCase() ?? "";
}
