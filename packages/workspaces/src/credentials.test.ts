import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "bun:test";
import { sessionCredentials, withoutGitTokens } from "./credentials";

async function write(
  dir: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
}

function askGit(
  variables: Readonly<Record<string, string>>,
  host: string,
): string {
  const { stdout } = spawnSync("git", ["credential", "fill"], {
    input: `protocol=https\nhost=${host}\n\n`,
    env: { PATH: process.env["PATH"], GIT_TERMINAL_PROMPT: "0", ...variables },
    encoding: "utf8",
  });

  return /^password=(.*)$/m.exec(stdout)?.[1] ?? "";
}

test("signs a Session's git and gh in with tokens it reads on each use, so fresh ones reach it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "credentials-"));

  const first = sessionCredentials(
    [
      { host: "github.com", token: "own-token" },
      { host: "github.tools.sap", token: "sap-token" },
    ],
    {},
    dir,
  );

  await write(dir, first.files);

  expect(askGit(first.variables, "github.tools.sap")).toBe("sap-token");
  expect(first.variables["GH_TOKEN"]).toBeUndefined();
  expect(first.variables["GH_CONFIG_DIR"]).toBe(join(dir, "gh"));

  await write(
    dir,
    sessionCredentials(
      [
        { host: "github.com", token: "own-token" },
        { host: "github.tools.sap", token: "fresh-token" },
      ],
      {},
      dir,
    ).files,
  );

  expect(askGit(first.variables, "github.tools.sap")).toBe("fresh-token");
  expect(askGit(first.variables, "github.com")).toBe("own-token");

  expect(await readFile(join(dir, "gh", "hosts.yml"), "utf8")).toBe(
    '"github.com":\n  oauth_token: "own-token"\n  git_protocol: https\n' +
      '"github.tools.sap":\n  oauth_token: "fresh-token"\n  git_protocol: https\n',
  );
});

test("leaves out the git hosts' tokens and the machine's credential helpers", () => {
  expect(
    withoutGitTokens({
      GH_TOKEN: "own-token",
      GITLAB_TOKEN: "lab-token",
      EDITOR: "vim",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.pager",
      GIT_CONFIG_VALUE_0: "cat",
    }),
  ).toEqual({
    EDITOR: "vim",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.pager",
    GIT_CONFIG_VALUE_0: "cat",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
  });
});
