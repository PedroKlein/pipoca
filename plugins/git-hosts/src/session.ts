import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SessionCloud, SessionPlugin } from "@pipoca/plugins";

const run = promisify(execFile);

// Watches the pull requests /pr opens (ADR 0051). /pr records each one in
// its checkout's git config, under branch.<name>.pipocaPullRequest.
export const gitHosts: SessionPlugin = {
  name: "git-hosts",
  extension: (cloud) => (pi) => {
    const watched = new Set<string>();

    const watchRecorded = async (): Promise<void> => {
      for (const url of await recordedPullRequests(cloud)) {
        if (watched.has(url)) {
          continue;
        }

        watched.add(url);

        const response = await cloud.request("pull-requests", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url }),
        });

        if (!response.ok) {
          watched.delete(url);

          cloud.log("could not watch a pull request", {
            url,
            status: response.status,
          });
        }
      }
    };

    const check = (): void => {
      watchRecorded().catch((failure: unknown) => {
        cloud.log("could not read recorded pull requests", {
          error: String(failure),
        });
      });
    };

    pi.on("session_start", check);
    pi.on("agent_settled", check);
  },
};

async function recordedPullRequests({
  checkouts,
}: SessionCloud): Promise<readonly string[]> {
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
